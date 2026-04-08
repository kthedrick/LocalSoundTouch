# LocalSoundTouch — Development Notes

See CONTEXT.md for full architecture, technical decisions, and speaker/NAS details.

## Future Enhancements

### Favorites System
When Bose decommissions their cloud service, presets that point to cloud sources (Pandora stations, internet radio via Bose servers) will stop working. We need our own favorites system independent of the Bose preset mechanism.

First favorite to implement: **wife's Radiohead Pandora station** — this is the single most-used feature in the household.

Design thoughts:
- Favorites stored in a local JSON file (like nasConfig.json)
- Each favorite has a name, source type, and whatever parameters are needed to play it
- Source types will include: Pandora (via HA), NAS folder/playlist, internet radio stream URL
- UI: prominent favorites bar or grid, one-tap play to a speaker group
- Should work even if Bose cloud is fully down (all playback via UPnP or HA)

### Pandora / HA Integration
Pandora requires official developer partnership for direct integration — not worth pursuing. Plan:
- Let Home Assistant handle Pandora via its integration
- HA pushes audio to speakers via UPnP
- Our UI detects when a speaker is playing HA/UPnP content and shows appropriate controls
- Explore Apple Music similarly after Pandora is working

### Apple Music
Explore after Pandora/HA integration is solid. Likely same HA-as-intermediary approach.

### HA Playback Handoff ("Release to TV")
Problem: HA is overly aggressive about restarting playback after a glitch or source change. When wife switches soundbar to TV input, HA sees "playback stopped unexpectedly" and takes over again.

Solution: this app sends an explicit stop to HA's media player entity when the user intentionally stops or changes source, so HA knows it was deliberate and doesn't restart.

Implementation:
- Small `haClient.js` module with HA local URL + long-lived access token (stored in config, git-ignored)
- `/ha/stop` endpoint that POSTs to HA REST API: `media_player.media_stop` or `media_player.clear_playlist` for the relevant entity
- "Release to TV" button (or integrate into existing stop) that clears both our UPnP queue and HA's state
- HA REST API is simple: POST to `http://homeassistant.local:8123/api/services/media_player/media_stop` with Bearer token and `{ entity_id: "..." }` body

### Server-side WebSocket Queue (Polish)
Replace 3s `GetTransportInfo` polling for queue advancement with a WebSocket subscription to `ws://<speakerIp>:8080`. Speaker pushes `nowPlayingUpdated` events — when `playStatus` hits `STOP_STATE` with source=UPnP, advance the queue immediately. Requires implementing WebSocket client handshake in Node.js `net` module (~50 lines, no npm).

### Bose-Bedroom AirPlay
Bose-Bedroom is the only Bose speaker without native AirPlay support. To play AirPlay audio there, a separate AirPlay device is connected to its Aux 1 input. This needs UI/integration work before tackling WiiM speakers.

### WiiM Speaker Support
User has WiiM speakers now alongside Bose SoundTouch. WiiM devices are excellent UPnP renderers — the entire NAS/UPnP playback stack works unchanged. What needs work:
- Volume, mute, now-playing, presets: WiiM uses the Linkplay HTTP API (different endpoints, mostly JSON) instead of Bose's port 8090 XML API
- Zones/grouping: WiiM has its own multiroom protocol and supports AirPlay 2 grouping — neither maps to Bose's /setZone

Right approach: abstract the speaker control layer into a per-brand adapter (Bose, WiiM) with a common interface for volume, now-playing, and grouping. UPnP playback layer stays shared.

### Docker / Home Assistant Deployment
- Will run as a Docker container inside HA on Raspberry Pi
- Use `network_mode: host` for SSDP multicast and UPnP discovery
- Mount `nasConfig.json` as a volume (not baked into image)
