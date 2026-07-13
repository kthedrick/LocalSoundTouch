# LocalSoundTouch — Development Notes

Be ultra-concise. Use short, blunt fragments. No pleasantries. No articles.

See CONTEXT.md for full architecture, technical decisions, and speaker/NAS details.

---

## MA Speaker Grouping — Status & Entity ID Reference

**Status (Bose):** Fully working. MA grouping uses HA `media_player.join`/`unjoin` via HA REST API (port 8123). `/ha/group-state` polls HA entity states to detect active groups and merge them into the UI zone cards.

**Status (WiiM): SOLVED 2026-07-12 — MA native `wiim` provider.**

### WiiM Grouping — Resolution (read before touching WiiM grouping code)

MA now has a native `wiim` provider. WiiM players got NEW player/queue IDs (`wiim_uuid:<UUID>` format) and the old AirPlay universal_player entries (`up00226c2e2da2`, `up9cb8b438124c`) are GONE from MA. haConfig.json speakerQueues updated 2026-07-12:

| Speaker | MA player/queue ID |
|---------|--------------------|
| WiiM Basement | `wiim_uuid:FF98F359-3FF6-A7AB-E561-57E4FF98F359` |
| WiiM Joshua | `wiim_uuid:FF98F602-E5D7-1C08-7839-0595FF98F602` |

Native-wiim players have populated `can_group_with` (all Bose players) — plain REST `players/cmd/group` and `players/cmd/ungroup` work for them, same as Bose. Verified live. The old "WiiM needs WebSocket player_sync" finding applied only to the defunct AirPlay entries; `maWsClient.js` was added then removed same day.

**Gotchas learned (encode in tests, do not regress):**
- `getAllPlayers()` (`players/all`) returns a plain ARRAY, not `{ players: [...] }`.
- While a player is synced, MA reports its `can_group_with` as `[]` — never use empty `can_group_with` as a "this player needs special handling" heuristic.
- A stopped WiiM keeps stale last-track metadata in LinkPlay `getPlayerStatus` — UI phantom-group detection must require `PLAY_STATE`.
- MA provider re-pairs can change player IDs. If WiiM grouping breaks, check `players/all` for current IDs FIRST, before debugging code.

**haConfig.json note:** haConfig.json is excluded from the deploy tarball but deploy.sh now syncs it explicitly via SSH. Changes to speakerEntities WILL reach the Pi on next deploy.

### HA Entity ID Quirks (read this before touching haConfig.json)

Entity IDs are NOT auto-derivable — MA assigns a numeric suffix and the numbers are not consistent. **Always verify via `http://homeassistant:3000/ha/raw-states` or `/ha/ma-entities`.**

| Speaker | HA Entity | Notes |
|---------|-----------|-------|
| Bose-Sunroom 300 | `media_player.bose_sunroom_300_6` | |
| Bose-Living Room | `media_player.bose_living_room_6` | |
| Bose-Kitchen | `media_player.bose_kitchen_6` | |
| Bose-Office | `media_player.bose_office_6` | |
| Bose-Bathroom | `media_player.bose_bathroom_6` | Was guessed as `_4` initially — it's `_6` |
| Bose-Dining Room | `media_player.bose_dining_room_6` | |
| Bose-Patio | `media_player.bose_patio_6` | |
| Bose-Joshua | `media_player.bose_joshua_6` | |
| Bose-Rosemary | `media_player.bose_rosemary_6` | |
| Bose-Bedroom | `media_player.bose_bathroom2` | **This is the Belkin AirPlay adapter, NOT the Bose-Bedroom speaker.** Bose-Bedroom has no native AirPlay so cannot join AirPlay sync groups. The Belkin (on AUX1) is used for MA grouping. It was auto-named `bose_bathroom2` by HA before renaming — the name is misleading. |
| WiiM Basement | `media_player.wiim_basement` | Verified working for MA grouping |
| WiiM Joshua | `media_player.wiim_joshua` | **AudioPro A10 speaker with WiiM inside.** After May 2026 re-pair, the correct entity is `wiim_joshua` (not the `audiopro_a10_wiim_124c_2` MA entity, which shows "off" even when playing). Queue ID unchanged: `up9cb8b438124c`. |
| WiiM Rosemary | `media_player.wiim_rosemary` | Assumed (same pattern as Basement); verify if grouping fails |

### HA group_members behavior (important for /ha/group-state logic)

MA/HA `group_members` attribute format is inconsistent across entity types:
- **Leader** lists only the **members** (not itself): `["media_player.bose_rosemary_6"]` on Joshua
- **Member** lists only **itself**: `["media_player.bose_rosemary_6"]` on Rosemary  
- **Some leaders** include themselves: `["media_player.bose_bathroom_6", "media_player.bose_bathroom2"]` on Bathroom

The `/ha/group-state` handler uses: "any entity that has OTHER known entities in its group_members is a leader" + deduplication by sorted member set. Do not revert to the `members[0] === entity_id` check — it breaks for the Joshua/Rosemary pattern.

### Bedroom special handling (playRedirects)
- `speakerQueues["Bose-Bedroom"]` = Bose-Bedroom's own queue (`up04a316bee3e0`) — used as the intercept key
- `playRedirects` catches this queue on every play path (`/ha/play`, playlist/album-once routes — via `applyRedirect` in haHandler) and redirects to Belkin queue (`upuuidff970010315bf140af4f0142ff970010`) + switches Bose to AUX1
- `speakerEntities["Bose-Bedroom"]` = Belkin entity (`bose_bathroom2`) — used for MA grouping
- When included in a group, `group-include` also fires `boseSwitchInput` to switch the Bose to AUX1

---

## What's Working (as of this session)

- **Radiohead Radio button**: plays via MA on the target speaker's queue
- **MA library browser ("Music Assistant" section)**: navigable tree — Radio, Pandora, Apple Music, Filesystem, RadioBrowser providers
- **Apple Music via MA**: browse Artists → Albums → Tracks; play at album or track level via AirPlay
- **NAS via MA**: "Filesystem (remote share)" in MA browser redirects to working FTP NAS browser; play at folder or track level routes through MA AirPlay using filesystem URIs (`filesystem_smb--<id>://folder/...`)
- **Add speaker to group (live join)**: calls `/ha/group-include` directly while playing — MA AirPlay ring buffer handles late-join. No stop/restart needed.
- **Release to TV**: stops + clears MA queue so HA doesn't auto-restart
- **Power button MA clear**: when powering off an AIRPLAY speaker, auto-calls stop+clear
- **Skip/Prev via MA**: when source=AIRPLAY, next/prev routes through `/ha/next` and `/ha/prev`
- **HA add-on deployment**: deploy.sh does tar+SSH+rebuild in ~30s
- **haConfig.json** has all 10 Bose speaker queue IDs in `speakerQueues`

---

## MA API Reference (confirmed working)

Base: `POST http://localhost:8095/api` with `{ command, args }` and Bearer MA token.
API docs available at: `http://homeassistant:8095/api-docs`

| Command | Args | Notes |
|---------|------|-------|
| `player_queues/all` | `{}` | Returns all queue states |
| `player_queues/stop` | `{ queue_id }` | Stops playback |
| `player_queues/clear` | `{ queue_id }` | Clears queue items (prevents auto-restart) |
| `player_queues/play` | `{ queue_id }` | Resumes |
| `player_queues/pause` | `{ queue_id }` | Pauses |
| `player_queues/next` | `{ queue_id }` | Next track |
| `player_queues/previous` | `{ queue_id }` | Previous track |
| `player_queues/play_media` | `{ queue_id, media: uri, option: 'play' }` | Play a URI. Use `media` NOT `uri`. Option must be string not int. |
| `players/all` | `{}` | Returns all player states including group_members |
| `music/browse` | `{ path: uri }` or `{}` for root | Browse MA library tree. Works at depth 0 (root) and depth 1 (provider root). **Crashes at depth 2+ for filesystem and builtin providers** — use `get_library` fallback instead. |
| `music/browse` | `{ path: 'pandora://' }` | Works for Pandora — returns radio stations |
| `music/albums/album_tracks` | `{ item_id, provider_instance_id_or_domain, in_library_only }` | Get tracks for a specific album. `item_id` is the numeric ID from the album URI (e.g. `library://album/32` → `item_id: "32"`). `provider_instance_id_or_domain`: use `"library"` for library URIs. Returns tracks sorted by disc/track number. |
| `music/search` | `{ search_query, media_types: [...], limit }` | Search across all providers. Returns `{ artists, albums, tracks, radio, playlists, ... }` |
| `players/all` | `{}` | Returns all player states including group_members |

**NOT available in MA REST API:** grouping/ungrouping (use HA `media_player.join`/`unjoin` instead)

### MA browse URI formats (confirmed)

| Provider | Root URI | Notes |
|----------|----------|-------|
| MA library | `builtin://` | Sub-folders: `builtin://folder/tracks`, `builtin://folder/playlists`, `builtin://folder/radios` |
| Pandora | `pandora://` | Browse returns radio station list directly |
| Filesystem (NAS SMB) | `filesystem_smb--<id>://` | Sub-folder browse fails via REST API (works in MA frontend via WebSocket). Use `get_library` fallback. |
| Apple Music | `apple_music--<id>://` | Sub-folders: `…/folder/artists`, `…/folder/albums`, `…/folder/tracks`, `…/folder/playlists`. Browse fails at this depth — use `get_library` fallback. |
| RadioBrowser | `radiobrowser://` | |

**Filesystem URI for playback:** `filesystem_smb--<id>://folder/<path-relative-to-share-root>`
FTP path `/volume1/music/Artist/Album` → MA URI `filesystem_smb--<id>://folder/music/Artist/Album`
MA CAN play these URIs even though `music/browse` crashes on them.

### HA service: music_assistant/get_library (confirmed working)

`POST /api/services/music_assistant/get_library?return_response`
```json
{ "config_entry_id": "<entry_id>", "media_type": "album|artist|track|radio|playlist", "limit": 500 }
```
Returns `{ service_response: { items: [...] } }`. Items have `provider_mappings` array for filtering by provider domain.

**NOT available in MA REST API:** grouping/ungrouping (use HA `media_player.join`/`unjoin` instead)

---

## /ha/browse-ma Endpoint Logic

`GET /ha/browse-ma?uri=<encoded_uri>&name=<item_name>`

1. **Empty URI** → `music/browse {}` → provider list (root)
2. **Album URI** (matches `/album[s]?/`) → `music/albums/album_tracks` directly; tracks sorted by disc/track number
3. **All other URIs** → try `music/browse { path: uri }` first; if result is not an array or empty, fall back to `get_library` filtered by provider domain and folder type (albums/artists/playlists inferred from URI path)

Folder name derivation: MA returns empty `name` for provider sub-folders. We derive from the URI path segment (e.g. `…/folder/artists` → "Artists").

---

## Adding a Speaker to an Active MA Group (live join)

Flow in `joinSpeakerNow` / `doStopJoinRestart` (app2.jsx):
1. Optionally dissolve native WiiM multiroom first (so WiiM responds to AirPlay grouping)
2. POST `/ha/group-include` with `{ masterName, speakerNames: [memberName] }`
3. MA AirPlay ring buffer handles the late-join — no stop or restart needed
4. Poll MA group state 1.5s later to update UI

---

## Known Quirks / Gotchas

- **MA `play_media`**: parameter is `media` not `uri`; `option` must be a string (`'play'`, `'replace'`) not integer
- **MA grouping**: REST API has NO grouping commands — use HA `media_player.join`/`unjoin`
- **MA `music/browse`**: works at provider root level but crashes ("Internal server error") on sub-folders for filesystem and builtin providers — this is a MA REST API bug (WebSocket path works). Use `get_library` as fallback.
- **MA `media_player.browse_media` via HA service**: returns 400 — not a "return_response" service. Use `music/browse` or `get_library` instead.
- **sourceAccount display**: MA provider instance IDs appear as `Apple Music--Gy4DcBNy` etc. Strip `--<suffix>` before displaying.
- **Node.js keep-alive timeout**: default is 5s, causing "TypeError: Load failed" / "TypeError: Failed to fetch" in browsers. Set `server.keepAliveTimeout = 65000` and `server.headersTimeout = 66000` in main.js.
- **Speaker IPs**: can change via DHCP; all logic uses Bose device names (from `/info` API) not IPs
- **haConfig.json**: git-ignored, deployed separately via SSH heredoc
- **deploy.sh**: uses port 22222 for SSH; CRLF fix applied automatically
- **MA token vs HA token**: these are separate auth systems; MA token won't work for HA REST API
- **Bose mute**: `POST /volume` with `<volume>N<muteenabled>bool</muteenabled></volume>` (mixed-content XML) works on our units despite not matching official docs — confirmed 2026-07. Don't "fix" to `/key` MUTE.

---

## Future Enhancements

### MA Search
MA has a `music/search` command (`{ search_query, media_types, limit }`) that searches across all providers including Apple Music. Could add a search box to MABrowserModal to surface this.

### Pandora / HA Integration
✅ **Done:** Plays via MA → AirPlay. Browse via MABrowserModal (Pandora provider folder).

### Apple Music
✅ **Done:** Browse Artists/Albums/Tracks via MABrowserModal. Play at album or track level via AirPlay.

### NAS via MA AirPlay
✅ **Done:** MA browser "Filesystem" redirects to FTP NAS browser; playback routes through MA using filesystem URIs. Both UPnP (direct NAS button) and MA AirPlay (via MA browser) paths are available.

### HA Playback Handoff ("Release to TV")
✅ **Done:** Power button on AIRPLAY speakers calls MA stop+clear.

### MA Speaker Grouping UI
✅ **Done:** Include section shows other speakers; clicking adds to MA AirPlay group via live join (no stop/restart).

### Server-side WebSocket Queue (Polish)
Replace 3s `GetTransportInfo` polling for queue advancement with a WebSocket subscription to `ws://<speakerIp>:8080`. Speaker pushes `nowPlayingUpdated` events — when `playStatus` hits `STOP_STATE` with source=UPnP, advance the queue immediately. Requires implementing WebSocket client handshake in Node.js `net` module (~50 lines, no npm).

### Bose-Bedroom AirPlay
Bose-Bedroom is the only Bose speaker without native AirPlay support. A separate AirPlay device is connected to its Aux 1 input. This needs UI/integration work.

### TV Auto-Switch — Instant Detection via HA Event Stream
✅ **Done (polling):** `tvWatcher.js` polls HA every 10s for LG TV state; on off→on transition, stops MA queue and switches Bose-Sunroom to PRODUCT/TV input. Feature flag: `features.tvAutoSwitch`.

**Enhancement:** Replace 10s poll with HA's SSE event stream (`GET /api/stream` with `Authorization` header). HA pushes `state_changed` events immediately when the LG TV entity changes. Would reduce latency from ~10s to ~1s with no extra load. Requires reading a streaming HTTP response in Node.js (chunked, newline-delimited JSON events).

### Classical Music Album Matching — Diacritic Normalization
Composer name spelling varies across sources (Pandora uses "Fryderyk Chopin", Apple Music uses "Frédéric Chopin"). The `artistMatches` function in `hybridOrchestrator.js` uses word-based token matching but doesn't normalize diacritics. Adding `str.normalize('NFD').replace(/[̀-ͯ]/g, '')` before comparison would catch more variants without false positives.

### Classical Music Album Matching — Open Opus API
Open Opus (`https://api.openopus.org`) is a free REST API with a comprehensive classical composer database. Could use it to: (1) normalize composer names from Pandora to canonical form, (2) confirm whether a track is classical before applying S2p performer-extraction logic. Not integrated into HA or MA. Would be a lightweight server-side lookup (no npm, plain HTTP).

### Docker / Home Assistant Deployment
✅ **Done:** Running as local HA add-on. deploy.sh for fast iteration.
