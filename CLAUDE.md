# LocalSoundTouch — Development Notes

See CONTEXT.md for full architecture, technical decisions, and speaker/NAS details.

---

## NEXT SESSION: MA Speaker Grouping via HA REST API

**Status:** The MA REST API (port 8095) is queue-control only. Grouping/ungrouping speakers requires HA's `media_player.join` / `media_player.unjoin` services via HA's REST API at port 8123.

**What's needed:**
1. HA long-lived access token (created in HA Profile → Long-Lived Access Tokens — different from the MA token)
2. Add to `haConfig.json` on the Pi:
   ```json
   "haUrl": "http://homeassistant:8123",
   "haToken": "<HA long-lived token>"
   ```
3. Implement `haPost(path, body)` in haHandler.js (same pattern as `maPost`)
4. Update `/ha/group-include` to call:
   ```
   POST /api/services/media_player/join
   { "entity_id": "media_player.bose_sunroom_300_music_assistant",
     "group_members": ["media_player.bose_living_room_music_assistant"] }
   ```
5. Update `/ha/group-remove` to call:
   ```
   POST /api/services/media_player/unjoin
   { "entity_id": "media_player.bose_living_room_music_assistant" }
   ```

**Entity ID derivation** (auto, no manual config needed):
- "Bose-Sunroom 300" → `media_player.bose_sunroom_300_music_assistant`
- Rule: lowercase, replace spaces/hyphens with underscores, append `_music_assistant`
- Use MA entities (not SoundTouchPlus entities which are prefixed `stp_`)

**Key caveats from MA docs:**
- Only Temporary Sync Groups support dynamic join/unjoin via HA actions
- AirPlay groups keep playing seamlessly when a new member joins (no pause)
- MA 2.7.x has a bug where the MA UI breaks dynamic member removal — use HA `media_player.unjoin` as workaround (our approach)
- Always target `*_music_assistant` entities, never `stp_*` entities
- `media_player.join`'s `group_members` field lists players being ADDED, not the full list

**UI problem still open:** When speakers are grouped via MA/HA, our app doesn't show them as grouped — we build zones from Bose's `/getZone` which knows nothing about MA groups. Need to either poll HA entity state for group_members or track MA group state in the server. Not solved yet.

**Current app-side code for Include (app2.jsx):** when `np.source === 'AIRPLAY'` and both `masterQueueId` and `targetQueueId` are known, calls `POST /ha/group-include { masterId, playerId }`. This is correct — just the server-side needs to be updated to use HA API.

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
