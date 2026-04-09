# LocalSoundTouch — Development Notes

See CONTEXT.md for full architecture, technical decisions, and speaker/NAS details.

---

## MA Speaker Grouping — Status & Entity ID Reference

**Status:** Fully working. MA grouping uses HA `media_player.join`/`unjoin` via HA REST API (port 8123). `/ha/group-state` polls HA entity states to detect active groups and merge them into the UI zone cards.

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

### HA group_members behavior (important for /ha/group-state logic)

MA/HA `group_members` attribute format is inconsistent across entity types:
- **Leader** lists only the **members** (not itself): `["media_player.bose_rosemary_6"]` on Joshua
- **Member** lists only **itself**: `["media_player.bose_rosemary_6"]` on Rosemary  
- **Some leaders** include themselves: `["media_player.bose_bathroom_6", "media_player.bose_bathroom2"]` on Bathroom

The `/ha/group-state` handler uses: "any entity that has OTHER known entities in its group_members is a leader" + deduplication by sorted member set. Do not revert to the `members[0] === entity_id` check — it breaks for the Joshua/Rosemary pattern.

### Bedroom special handling (playRedirects)
- `speakerQueues["Bose-Bedroom"]` = Bose-Bedroom's own queue (`up04a316bee3e0`) — used as the intercept key
- `playRedirects` catches this queue on `/ha/play` and redirects to Belkin queue (`upcc4b73fe2466`) + switches Bose to AUX1
- `speakerEntities["Bose-Bedroom"]` = Belkin entity (`bose_bathroom2`) — used for MA grouping
- When included in a group, `group-include` also fires `boseSwitchInput` to switch the Bose to AUX1

---

## What's Working (as of this session)

- **Radiohead Radio button**: plays via MA on the target speaker's queue
  - Command: `player_queues/play_media` with `media` (not `uri`!) and `option: 'play'`
  - Wired to `haConfig.speakerQueues[speakerName]` for per-speaker targeting
- **Release to TV**: stops + clears MA queue (Sunroom only) so HA doesn't auto-restart
  - Calls `player_queues/stop` then `player_queues/clear` on both speaker queue AND AirPlay group
  - Works — confirmed stops MA from restarting after intentional power-off
- **Power button MA clear**: when powering off an AIRPLAY speaker, auto-calls stop+clear on MA queues
- **Skip/Prev via MA**: when source=AIRPLAY, next/prev routes through `/ha/next` and `/ha/prev`
- **HA add-on deployment**: deploy.sh does tar+SSH+rebuild in ~30s
- **haConfig.json** has all 10 Bose speaker queue IDs in `speakerQueues`

---

## MA API Reference (confirmed working)

Base: `POST http://localhost:8095/api` with `{ command, args }` and Bearer MA token.

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

**NOT available in MA REST API:** grouping/ungrouping (use HA `media_player.join`/`unjoin` instead)

---

## Future Enhancements

### Pandora / HA Integration
✅ **Done:** Radiohead Radio plays via MA → AirPlay → Bose speakers. One-tap from our app.

Next: expand favorites system with additional stations.

### Apple Music
Explore after Pandora is solid. Likely same MA-as-intermediary approach.

### HA Playback Handoff ("Release to TV")
✅ **Done:** Power button on AIRPLAY speakers calls MA stop+clear. HA automation approach was also built in HA as backup (`rest_command.stop_ma_sunroom_300` / `clear_ma_sunroom_300`).

### MA Speaker Grouping UI
After grouping works (see NEXT SESSION above), need to surface MA group state in the UI:
- Poll HA entity state (`/api/states/media_player.bose_*_music_assistant`) to get `group_members`
- Merge with Bose zone data in AllSpeakersView to show grouped speakers together
- Or: track MA group state server-side and expose via `/ha/group-state`

### Server-side WebSocket Queue (Polish)
Replace 3s `GetTransportInfo` polling for queue advancement with a WebSocket subscription to `ws://<speakerIp>:8080`. Speaker pushes `nowPlayingUpdated` events — when `playStatus` hits `STOP_STATE` with source=UPnP, advance the queue immediately. Requires implementing WebSocket client handshake in Node.js `net` module (~50 lines, no npm).

### Bose-Bedroom AirPlay
Bose-Bedroom is the only Bose speaker without native AirPlay support. A separate AirPlay device is connected to its Aux 1 input. This needs UI/integration work.

### WiiM Speaker Support
WiiM devices work for UPnP/NAS playback already. What needs work:
- Volume, mute, now-playing: WiiM uses Linkplay HTTP API (different from Bose port 8090 XML)
- Zones/grouping: WiiM has its own multiroom protocol, doesn't map to Bose `/setZone`
- Right approach: per-brand adapter (Bose, WiiM) with common interface

### Docker / Home Assistant Deployment
✅ **Done:** Running as local HA add-on. deploy.sh for fast iteration.

---

## Known Quirks / Gotchas

- **MA `play_media`**: parameter is `media` not `uri`; `option` must be a string (`'play'`, `'replace'`) not integer
- **MA grouping**: REST API has NO grouping commands — use HA `media_player.join`/`unjoin`
- **Speaker IPs**: can change via DHCP; all logic uses Bose device names (from `/info` API) not IPs
- **haConfig.json**: git-ignored, deployed separately via `scp -P 22222` or SSH heredoc (scp subsystem sometimes fails, use heredoc)
- **deploy.sh**: uses port 22222 for SSH; CRLF fix applied automatically
- **MA token vs HA token**: these are separate auth systems; MA token won't work for HA REST API
