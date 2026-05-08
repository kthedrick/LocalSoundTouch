# LocalSoundTouch — Project Context

## What This Is

A custom Bose SoundTouch controller built to replace functionality lost as Bose deprecates their cloud content API. Runs as a Node.js HTTP server with a React/Tailwind UI, served to any browser on the LAN.

**Deployment target:** Docker container running as a local HA add-on inside Home Assistant OS on Raspberry Pi.

**Status (May 2026):** Bose cloud shut down **May 6, 2026**. Cloud-dependent presets (Pandora, TuneIn internet radio) show `INVALID_SOURCE` when pressed. Pandora playback via the Bose app is dead. All functionality now routes through MA (AirPlay) or local UPnP. The app is the primary interface.

---

## Why This Exists

- Bose is deprecating their cloud-based content selection API
- Home Assistant's SoundTouch integration is poorly maintained and lags behind API changes
- HA Lovelace UI is too inflexible for a polished family-friendly experience
- This gives full control over UI (important — wife uses it daily) and playback logic

---

## Architecture

### Server (`main.js`)
- Plain Node.js HTTP server on port 3000, no npm packages
- Detects LAN IP via `os.networkInterfaces()` and exposes it as `SERVER_BASE`
- Runs speaker discovery (SSDP/mDNS) and NAS mount on startup

### Routing (`httpProxy.js`)
| Path | Handler |
|------|---------|
| `/api/<ip>/<endpoint>` | Proxy to Bose HTTP API (port 8090) |
| `/nas/*` | NAS file browser and audio streamer |
| `/upnp/*` | UPnP AVTransport control + queue |
| `/ha/*` | Music Assistant integration (`haHandler.js`) |
| `/speakers` | Discovered speaker list |
| `/serverInfo` | Returns `{ base: "http://<LAN_IP>:3000" }` |
| `/*` | Static files from `public/` |

WebSocket connections (`ws://`) are proxied separately via `wsProxy.js`.

### NAS Playback (`nasHandler.js` + `ftpClient.js`)
- NAS: TP-LINK router USB drive at `192.168.1.3`, accessed via FTP (port 21)
- SMB was abandoned — Windows 11 disables SMBv1, which is all the TP-Link supports
- `ftpClient.js` is pure Node.js `net` module (no npm): implements PASV, LIST, SIZE, RETR
- Audio is streamed: FTP RETR socket piped directly into the HTTP response
- `nasConfig.json` (git-ignored) holds `{ host, share, username, password }`

### UPnP Playback (`upnpHandler.js`)
- Uses SSDP (UDP multicast 239.255.255.250:1900, ST: ssdp:all) to discover each speaker's UPnP device description URL dynamically
- Parses device XML to find AVTransport controlURL, cached per IP
- Sends SOAP actions: `SetAVTransportURI`, `Play`, `Stop`, `GetTransportInfo`
- Speaker UPnP found at port 8091, path `/AVTransport/Control`

#### Server-Side Queue
Folder playback uses a server-side queue (`queues` map in `upnpHandler.js`):
1. Client POSTs `{ speakerIp, tracks: [{url, title}] }` to `/upnp/queue`
2. Server plays first track via UPnP
3. Server polls `GetTransportInfo` every 3s; when state is `STOPPED`, advances to next track
4. Queue is cleared on `/upnp/stop` or when a new queue is posted

This approach was chosen over browser-side queue management because the server runs 24/7 in Docker — playback continues even when the browser is closed.

### Music Assistant Integration (`maClient.js` + `haHandler.js`)
Music Assistant (MA) runs inside Home Assistant on the same Pi, accessible at `http://localhost:8095/api`.

**`maClient.js`** — thin MA API client (no npm):
- `maPost(command, args)` — authenticated POST to MA REST API
- `playMedia(queueId, uri)` — play a URI on a specific queue (`option: 'replace'`)
- `stopQueue`, `clearQueue`, `pauseQueue`, `resumeQueue`, `nextTrack`, `prevTrack`, `getAllQueues`
- Config (token, URL, queue IDs) read from `haConfig.json`

**`haHandler.js`** — HTTP routes for MA and HA:
| Route | Purpose |
|-------|---------|
| `GET /ha/config` | Returns safe config (queues, speakerQueues, speakerEntities, favorites, playRedirects) for the UI |
| `GET /ha/queues` | Lists all MA queues (discovery/debug) |
| `GET /ha/group-state` | Returns active MA sync groups by polling HA entity `group_members` attributes |
| `GET /ha/queue-now-playing?queueId=` | Returns track/artist/art/duration/position from MA queue |
| `GET /ha/raw-states` | Dumps raw HA entity states for all speakerEntities (debug) |
| `GET /ha/ma-entities` | Lists all non-STP media_player entities from HA (debug/discovery) |
| `POST /ha/stop` | Stop a queue `{ queueId }` |
| `POST /ha/pause` | Pause a queue |
| `POST /ha/resume` | Resume a queue |
| `POST /ha/next` | Next track |
| `POST /ha/prev` | Previous track |
| `POST /ha/play` | Play a URI `{ queueId, uri }` — checks `playRedirects` before playing |
| `POST /ha/clear` | Clear a queue |
| `POST /ha/group-include` | Join speaker into MA group via HA `media_player.join` `{ masterName, speakerName }` |
| `POST /ha/group-remove` | Unjoin speaker from MA group via HA `media_player.unjoin` `{ speakerName }` |

**`haConfig.json`** — MA + HA configuration (deployed via deploy.sh, NOT git-tracked):

Key sections:
- `haUrl` / `haToken` — HA REST API base URL and long-lived token (separate from MA token)
- `maUrl` / `maToken` — MA REST API and token
- `queues` — named MA queue IDs for internal use
- `speakerQueues` — maps Bose speaker name → MA queue ID (used for per-speaker favorites + skip/prev routing)
- `speakerEntities` — maps Bose speaker name → HA `media_player` entity ID (used for MA grouping via HA)
- `releaseToTV` — list of speaker names that show the "Release to TV" button
- `favorites` — list of `{ name, icon, uri, defaultQueueId }` shown as one-tap play buttons
- `groupSideEffects` — rules that flip HA switches when specific speakers are grouped/ungrouped
- `playRedirects` — intercepts `/ha/play` for speakers needing special routing (e.g. Bedroom → Belkin AUX)
- `presetActions` — maps speaker name → preset ID → MA URI. When a Bose preset button fires `nowSelectionUpdated`, this is checked first for an instant MA play. Example: `{ "Bose-Bathroom": { "5": "library://radio/1" } }`
- `invalidSourceFallback` — `{ "uri": "..." }` — polling fallback for any dead preset not in `presetActions`. Per-speaker override: `"Bose-Joshua": { "uri": "..." }` nested inside.

**MA API details (confirmed working):**
- REST endpoint: `POST http://localhost:8095/api` with `{ command, args }` and Bearer MA token
- `play_media` args: `{ queue_id, media: uri, option: 'replace' }` — use `media` NOT `uri`; `option` must be string not int
- Queue IDs: `up` + MAC fragment for Bose/UPnP; `syncgroup_*` for AirPlay groups; `upuuid*` for some AirPlay adapters
- Grouping is NOT available in MA REST API — use HA `media_player.join`/`unjoin` instead
- MA token: long-lived JWT from HA → Settings → People → user → Long-Lived Access Tokens

### UI (`public/js/app2.jsx`)
- React 18 UMD + Babel standalone (no build step)
- Tailwind CDN
- `AllSpeakersView` polls all speakers every 15s, builds zone groups from `/getZone` responses
- `GroupCard` shows now-playing, volume controls, presets, Include/SyncTo, and NAS browser button
- `NasBrowserModal` — FTP folder browser with shuffle toggle, queues tracks via `/upnp/queue`

#### Key behavioral details
- **Speaker identification:** All logic uses Bose speaker names (from `/info` API), not IPs. IPs can change; names are stable. Discovery maps IP→name at runtime.
- **Favorites (MA):** Shown in GroupCard when `haConfig.speakerQueues[master.name]` exists. One-tap plays the favorite's URI on that speaker's MA queue.
- **AIRPLAY source routing:** When `nowPlaying.source === 'AIRPLAY'`, skip/prev/include all route through MA instead of Bose API. Power-off also calls MA stop+clear+group-remove.
- **AUX source routing:** When source is `AUX` and a `playRedirect` exists for the speaker's queue, skip/prev route through MA on the redirect's `toQueue`. MA track data is also polled from the redirect queue.
- **MA group display:** `AllSpeakersView` polls `/ha/group-state` every 15s. Detected MA groups are merged into Bose zone cards in the UI — members are appended to the leader's card and their standalone cards are suppressed.
- **Release to TV:** Shown only on speakers in `haConfig.releaseToTV` (Sunroom 300). Stops+clears MA queue so HA doesn't auto-restart when soundbar switches to TV.
- **Per-speaker power button (⏻):** Shown in the speaker header row of each zone card.
- **Sort order:** Sunroom 300 sorts first; other zones follow alphabetically.
- **MA track metadata:** When source=AIRPLAY or source=AUX (with redirect), polls `/ha/queue-now-playing` for track/artist/art/duration/position. Progress bar and timer use MA data when Bose reports 0.
- **groupSideEffects:** After any MA group change, server checks rules and flips HA switches. Currently: turns on `switch.living_room_bass` when Sunroom 300 + Living Room are grouped (bass module is physically wired to Sunroom output).
- **playRedirects:** Intercepts `/ha/play` by matching `fromQueue`. For Bedroom: switches Bose-Bedroom to AUX1 and plays on Belkin AirPlay queue instead. Also fires `boseSwitchInput` when Bedroom is included into a group via `group-include`.

#### Key Bose API quirk
`/getZone` sometimes returns empty `senderIPAddress`. Fix: when `senderIPAddress` is empty but members exist, infer master IP = the queried speaker's IP.

---

## Speaker List
| Speaker Name (Bose /info) | IP | MA Queue ID | HA Entity ID | Notes |
|---|---|---|---|---|
| Bose-Sunroom 300 | 192.168.1.229 | upb0d5cccfcf13 | media_player.bose_sunroom_300_6 | |
| Bose-Living Room | 192.168.1.170 | up304511da849b | media_player.bose_living_room_6 | was .171 |
| Bose-Kitchen | 192.168.1.185 | upf8369b11ce57 | media_player.bose_kitchen_6 | |
| Bose-Office | 192.168.1.161 | upf45eab9402de | media_player.bose_office_6 | was .162 |
| Bose-Bathroom | 192.168.1.245 | upf0b5d19709fc | media_player.bose_bathroom_6 | was .120 |
| Bose-Rosemary | 192.168.1.40 | up5cf821f13410 | media_player.bose_rosemary_6 | |
| Bose-Joshua | 192.168.1.92 | upb0d5cc50ef39 | media_player.bose_joshua_6 | was .91 |
| Bose-Bedroom | 192.168.1.176 | up04a316bee3e0 | media_player.bose_bathroom2* | No native AirPlay — see below |
| Bose-Dining Room | 192.168.1.55 | up3881d72fc987 | media_player.bose_dining_room_6 | |
| Bose-Patio | 192.168.1.7 | upd8a98bcbc0f6 | media_player.bose_patio_6 | |

**Bose-Bedroom special handling:**
- Has no native AirPlay. A Belkin AirPlay adapter is connected to AUX1.
- For Pandora playback: `playRedirects` intercepts the play call, switches Bose to AUX1, and plays on the Belkin's MA queue (`upuuidff970010315bf140af4f0142ff970010`)
- For MA grouping: `speakerEntities["Bose-Bedroom"]` points to the Belkin's HA entity (`media_player.bose_bathroom2` — misleadingly named, was auto-assigned before renaming)
- When Bedroom is added to an AIRPLAY group: HA joins the Belkin + Bose switches to AUX1 automatically
- When Bedroom is master (AUX source): Bose native zoning works normally to add other speakers

**\* HA entity ID note:** All Bose speakers use `_6` suffix (highest number = last MA entity added). Bathroom uses `_6` not `_4`. The Belkin entity `bose_bathroom2` is a legacy auto-name. Do NOT try to auto-derive entity IDs — verify via `/ha/raw-states`.

Also present in MA:
- Joshua's WiiM (`up9cb8b438124c`, entity: media_player — verify via /ha/ma-entities)
- Basement WiiM (`up00226c2e2da2`)
- Belkin AirPlay (Bedroom): `upuuidff970010315bf140af4f0142ff970010`

---

## HA Add-on Deployment

### Structure (files in repo root)
| File | Purpose |
|------|---------|
| `config.yaml` | HA add-on manifest (slug, ports, host_network, options schema) |
| `Dockerfile` | `FROM node:20-alpine`, copies app, EXPOSE 3000 |
| `run.sh` | Reads `/data/options.json` (NAS creds from HA UI) → writes `nasConfig.json`, then `exec node main.js` |
| `.dockerignore` | Excludes .git, .claude, *.pdf, nasConfig.json, node_modules, deploy.sh |
| `deploy.sh` | Fast update script: tar+SSH to Pi, fix CRLF, `ha apps rebuild`, `ha apps start` |

### deploy.sh workflow
```bash
# One-time: set up SSH key in HA SSH add-on config
# Then:
./deploy.sh
# Opens http://homeassistant:3000 when done
```

Internally:
```bash
tar -czf - --exclude='./.git' ... . | ssh root@homeassistant "tar -xzf - -C /addons/localsoundtouch"
ssh root@homeassistant "sed -i 's/\r//' /addons/localsoundtouch/config.yaml ..."  # fix CRLF
ssh root@homeassistant "ha apps rebuild local_localsoundtouch"
ssh root@homeassistant "ha apps start local_localsoundtouch 2>/dev/null || true"
```

### Key deployment gotchas
- **CRLF:** Windows line endings break HA Supervisor YAML parsing — always fix with `sed -i 's/\r//'`
- **`ha addons` is deprecated** — use `ha apps` instead
- **network_mode: host** — required for SSDP multicast to work inside Docker
- **haConfig.json** is git-ignored and IS excluded from deploy.sh. Must be deployed separately: `ssh -p 22222 root@homeassistant "cat > /addons/localsoundtouch/haConfig.json" < haConfig.json` followed by `ha apps rebuild local_localsoundtouch`. The Pi's copy is authoritative.
- **MA reachable as `localhost`** — MA runs on the same Pi; Docker host networking makes `localhost:8095` work

---

## Future TODOs

### TV Card: Episode Synopsis via TMDB/IMDb

The Apple TV entity in HA exposes `media_title`, `media_series_title`, `media_season`, `media_episode`, and artwork — but no synopsis. Apple's MRP protocol doesn't broadcast episode descriptions.

Synopsis is available from:
- **TMDB API** (free tier, requires API key) — search by title, returns `overview` field
- **IMDb** — episode pages carry synopsis (e.g. `https://www.imdb.com/title/tt27544465/`) but no official free API; scraping or a third-party wrapper would be needed

Implementation approach: in the `/ha/tv-state` handler, after fetching the Apple TV entity state, do a TMDB title search using `media_title` (plus series/season/episode if available) and append the `overview` to the response. Add a `tmdbApiKey` field to `haConfig.json`.

---

### Test Cases

Run these in order. Each has a setup, action, and expected result.

---

#### 1. Basic MA playback (Radiohead Radio on single speaker)
- **Setup:** All speakers off / idle
- **Action:** Open a single speaker card (e.g. Sunroom), tap Radiohead Radio
- **Expected:** Card shows AIRPLAY source, MA track info (title/artist/art) appears within ~5s, progress timer runs

---

#### 2. Skip / prev during Pandora
- **Setup:** Radiohead Radio playing on a single speaker
- **Action:** Tap next track, then prev track
- **Expected:** Track changes each time; title/art updates within a few seconds

---

#### 3. Power off during Pandora (single speaker)
- **Setup:** Radiohead Radio playing on one speaker
- **Action:** Tap power button on that speaker's card
- **Expected:** Speaker goes to standby. MA does NOT restart playback (stop+clear was called). Card shows standby/off state.

---

#### 4. MA grouping — add a second speaker
- **Setup:** Radiohead Radio playing on Sunroom (or any single speaker)
- **Action:** Tap the Include (+) button, select another speaker (e.g. Kitchen)
- **Expected:** Both speakers play in sync. UI merges into one card. Track info visible on the combined card.

---

#### 5. MA group — remove a speaker (X button)
- **Setup:** Sunroom + Kitchen grouped and playing
- **Action:** Tap X on Kitchen within the group card
- **Expected:** Kitchen separates back to its own card (idle). Sunroom card continues playing solo.

---

#### 6. Bass switch side effect — Sunroom + Living Room
- **Setup:** Radiohead Radio playing on Sunroom
- **Action:** Add Living Room to the group (Include)
- **Expected:** `switch.living_room_bass` turns ON in HA. Check: `http://homeassistant:3000/ha/raw-states` or HA dashboard.
- **On removal:** Remove Living Room from group → bass switch turns OFF.

---

#### 7. Bass switch does NOT fire for unrelated groups
- **Setup:** Radiohead Radio playing on Sunroom
- **Action:** Add Kitchen (not Living Room) to the group
- **Expected:** `switch.living_room_bass` is NOT toggled. Only fires when Living Room is involved.

---

#### 8. Bedroom AUX redirect — play Pandora on Bedroom
- **Setup:** All idle
- **Action:** Play Radiohead Radio targeting Bedroom (tap Radiohead Radio on Bedroom card)
- **Expected:** Bose-Bedroom switches to AUX1 input. Belkin AirPlay device picks up playback. Card shows AUX source + MA track info.

---

#### 9. Bedroom — add to Pandora group (Bedroom as follower)
- **Setup:** Radiohead Radio playing on Sunroom
- **Action:** Include Bose-Bedroom into the Sunroom group
- **Expected:** Bose-Bedroom switches to AUX1 (Belkin joins the AirPlay group). Bedroom card merges with Sunroom. Audio audible in Bedroom.

---

#### 10. Power off Bedroom while grouped
- **Setup:** Bedroom grouped with Sunroom (Pandora playing)
- **Action:** Tap power on Bedroom card
- **Expected:** Bedroom separates back to its own card. Sunroom continues playing. HA unjoins the Belkin entity.

---

#### 11. Bathroom grouping
- **Setup:** Radiohead Radio playing on Sunroom
- **Action:** Include Bathroom into the group
- **Expected:** Bathroom joins and syncs. No bass switch effect (only Sunroom+LivingRoom triggers it). Bathroom card merges.

---

#### 12. Bathroom + Bedroom not permanently linked (regression check)
- **Setup:** Play and group Bathroom + Bedroom together, then separate them (X button or power off one)
- **Expected:** Cards separate cleanly. `/ha/group-state` shows no lingering group between them. Debug: `http://homeassistant:3000/ha/raw-states`

---

#### 13. TV card — LG on non-Apple TV input
- **Setup:** LG TV on (e.g. Netflix)
- **Expected:** TV card appears at top of UI showing "Sunroom TV" and the app name (e.g. "Netflix"). No art.

---

#### 14. TV card — LG on Apple OTT input
- **Setup:** Switch LG TV to Apple TV input ("Apple OTT")
- **Expected:** Card switches to show "Apple TV" label, current title/artist if something is playing, and album art if available. Updates within 10s.

---

#### 15. TV card hidden when TV off
- **Setup:** Turn LG TV off
- **Expected:** TV card disappears from the UI within 10s.

---

#### 16. Release to TV (Sunroom)
- **Setup:** Radiohead Radio playing on Sunroom
- **Action:** Power off Sunroom speaker
- **Expected:** HA does NOT restart Pandora automatically. MA queue is stopped and cleared. Sunroom card shows standby.

### Pandora station URI
`library://radio/2` works but needs monitoring. If MA resets Pandora auth, the URI may change. Verify by playing in MA UI and checking `/ha/queues` for the active `current_item.media_item.uri`.

### More favorites
Only Radiohead Radio is in `haConfig.favorites`. Easy to add more once Pandora is stable.

### WiiM speaker support
WiiM devices are excellent UPnP renderers — NAS/UPnP playback stack works unchanged. What needs work:
- Volume, mute, now-playing: WiiM uses Linkplay HTTP API (different endpoints, JSON) instead of Bose port 8090 XML
- Zones/grouping: WiiM has its own multiroom protocol, not compatible with Bose `/setZone`
- Right approach: abstract speaker control into a per-brand adapter (Bose, WiiM) with common interface

### Server-side WebSocket subscription (queue improvement)
**Current:** queue advances by polling `GetTransportInfo` every 3s via UPnP SOAP.  
**Better:** use the existing boseWatcher WebSocket connection (already open on all 10 speakers) and listen for `nowPlayingUpdated` where `playStatus = STOP_STATE` and source=UPnP. Advance the queue immediately instead of waiting up to 3s.  
**Status:** boseWatcher WebSocket is implemented and connected — adding UPnP queue advancement is a small extension to `handleWsEvent`.

### HA Ingress / HTTPS
Currently plain HTTP on LAN. Options: HA Ingress (HTTPS via HA's reverse proxy, but requires iframe-compatible UI), or Caddy/nginx on Pi. Not urgent.

### Scheduled playback / alarms
Post-May-6 stretch goal.

---

## Bose Cloud Shutdown — Post May 2026

### What died on May 6, 2026
- Pandora, TuneIn, Amazon Music via Bose presets
- Official Bose SoundTouch app (limited functionality only)
- Cloud-based preset content: pressing a TuneIn/Pandora preset shows `INVALID_SOURCE`
- `LOCAL_INTERNET_RADIO` source via `/select` — speaker accepts the request but never fetches the descriptor URL (cloud was the resolver, not the speaker itself)

### What still works locally
- All Bose REST API endpoints (port 8090): now-playing, volume, zones, presets (read), key presses
- UPnP/NAS playback (unaffected — was always local)
- AirPlay via MA (unaffected — runs on Pi via HA)
- Pandora via MA (MA uses its own Pandora auth, independent of Bose cloud)
- Physical preset buttons still fire `nowSelectionUpdated` WebSocket events

### 99.5 WCRB Radio
WCRB was the primary dead preset (preset 5 on all speakers). It's been replaced via MA:

- **MA library URI:** `library://radio/1` — already in the user's MA library as "WCRB"
- **RadioBrowser UUID:** `b536a4b6-1b26-44af-bac3-0deb55f997bb` (MA URI: `radiobrowser://radio/b536a4b6-1b26-44af-bac3-0deb55f997bb`)
- **Stream:** `https://wgbh-live.streamguys1.com/classical-hi` — 192 kbps MP3, WGBH/classical-hi feed
- **In haConfig.favorites:** `{ "name": "99.5 WCRB", "icon": "🎼", "uri": "library://radio/1" }` — appears as one-tap button in every speaker card

### boseWatcher.js — Preset Intercept System

**File:** `boseWatcher.js` (fallback: `boseWatcher.polling.js`)

Runs two parallel mechanisms per speaker:

#### 1. WebSocket (primary — instant)
Opens a persistent WebSocket connection to each speaker on port 8080.

**Reference:** [libsoundtouch](https://libsoundtouch.readthedocs.io/en/latest/) ([source](https://github.com/CharlesBlonde/libsoundtouch)) — Python library for Bose SoundTouch. Its `device.py` reveals the correct WebSocket URL format (`ws://<host>:<port>/`). The Python `websocket-client` library it uses automatically sends `User-Agent` and `Accept` headers which turned out to be required.

**Critical handshake requirements** (discovered by comparing curl success vs Node.js failure — libwebsockets on Bose rejects without these):
```
GET / HTTP/1.1                          ← path is /, NOT /WebSocket
Host: <ip>:8080
User-Agent: LocalSoundTouch/1.0        ← REQUIRED — connection silently closed without it
Accept: */*                            ← REQUIRED — connection silently closed without it
Upgrade: websocket
Origin: http://<ip>:8080
Sec-WebSocket-Key: <base64>
Sec-WebSocket-Version: 13
Sec-WebSocket-Protocol: gabbo
Connection: Upgrade
```

Speaker responds with `HTTP/1.1 101` + immediately sends:
```xml
<SoundTouchSdkInfo serverVersion="4" serverBuild="trunk r46330 v4 epdbuild hepdswbld04" />
```

**Events handled:**
- `nowSelectionUpdated` — fires the instant a preset button is pressed (before cloud attempt). Contains `<preset id="N">`. Looks up `haConfig.presetActions[speakerName][presetId]` and plays via `/ha/play`.
- `nowPlayingUpdated` — not currently acted on (previously used for source tracking; removed when polling got its own state).

**Reconnect:** 20s after disconnect.

#### 2. HTTP polling (fallback — ~15s latency)
Polls `/now_playing` on each speaker every 15s. Detects `INVALID_SOURCE` transition (speaker stuck in cloud-failed state). Plays `haConfig.invalidSourceFallback.uri` on the speaker's MA queue. Uses its own `prev` variable independent of WebSocket state.

#### haConfig fields
```json
"presetActions": {
  "Bose-Bathroom":    { "5": "library://radio/1" },
  "Bose-Joshua":      { "5": "library://radio/1" },
  "Bose-Rosemary":    { "5": "library://radio/1" },
  "Bose-Sunroom 300": { "5": "library://radio/1" },
  "Bose-Living Room": { "5": "library://radio/1" },
  ...all 10 speakers...
},
"invalidSourceFallback": { "uri": "library://radio/1" }
```

#### When Pandora eventually dies
Add presets 3 and 4 to `presetActions`:
```json
"3": "library://radio/5",   ← Yo-Yo Ma Radio (MA Pandora station)
"4": "library://radio/2"    ← Radiohead Radio (MA Pandora station)
```
These MA library URIs are already confirmed working.

### WebSocket API findings (from SoundTouch-Web-API.pdf)

Key events:
| Event | When it fires |
|-------|--------------|
| `nowSelectionUpdated` | Preset button pressed — contains `<preset id="N">`. Fires BEFORE cloud attempt. |
| `nowPlayingUpdated` | Source/track changes — contains full `<nowPlaying source="...">` |
| `presetsUpdated` | Preset slots modified |
| `volumeUpdated` | Volume changed |
| `zoneUpdated` | Zone/group changed |

`nowSelectionUpdated` is the key event for preset interception — it fires immediately on button press and includes the preset ID, unlike `nowPlayingUpdated` which only fires after the cloud attempt starts (and shows `INVALID_SOURCE` if it fails).

---

## What Was Tried and Abandoned

| Approach | Why Abandoned |
|----------|--------------|
| SMB for NAS access | Windows 11 disables SMBv1; TP-Link only supports SMBv1 |
| `LOCAL_INTERNET_RADIO` source via Bose `/select` | Speaker accepted request (200 OK) but never fetched descriptor URL — not supported on this model |
| M3U playlist via UPnP | UPnP AVTransport doesn't natively handle M3U — replaced with server-side queue |
| Browser-side queue management | Requires browser tab to stay open; incompatible with Docker/always-on server use case |
| Pure Home Assistant UI (Lovelace) | Inflexible for a polished, family-friendly interface |
| `rsync` for deploy | Not available in Git Bash on Windows — replaced with `tar \| ssh` |
| `ha addons` CLI command | Deprecated in newer HA OS — use `ha apps` |
| `music/play_media` MA command | MA accepted it but nothing played — reverted to `player_queues/play_media` |
| Separate `player_queues/play` after `play_media` | Resumed "active" queue (Living Room) not target queue — wrong speaker played |
| Hardcoded speaker IPs | IPs change via DHCP; switched to name-based identification from Bose `/info` API |
| `option: 1` (int) for play_media | MA requires string: `'replace'` not integer. Int caused "Internal server error" |
| `uri` param for play_media | MA requires `media` not `uri`. Caused silent failure then "Internal server error" |
| MA REST API for grouping | No grouping commands in MA REST API. Must use HA `media_player.join`/`unjoin` |
| `_music_assistant` entity suffix | MA entities use numeric suffix (`_6`), not `_music_assistant`. Auto-derivation doesn't work |
| `media_player.bose_bathroom_4` for Bathroom | Wrong — it's `_6`. HA returns 200 for join regardless, masking the error |
| `upapf4e11ee0766b` for Bathroom queue | Wrong MAC-derived ID — actual MA queue is `upf0b5d19709fc` |
| `upcc4b73fe2466` for Belkin queue | This queue disappeared from MA — correct Belkin queue is `upuuidff970010315bf140af4f0142ff970010` |
| `members[0] === entity_id` leader detection | Breaks for Joshua/Rosemary where leader lists only members (not self). Use "has other known entities" + dedup instead |
| `POST /presets` to reprogram preset 5 | Returns `CLIENT_XML_ERROR` for all formats tried. Preset writes appear to require the cloud protocol, not the local REST API. Presets can only be saved via physical long-press. |
| `LOCAL_INTERNET_RADIO` JSON descriptor approach | Speaker accepts `/select` (returns 200), briefly shows the source in now-playing, but never fetches the JSON URL or the stream URL from it. The cloud was the resolver. Doesn't work post-shutdown. |
| Audio stream proxy for LOCAL_INTERNET_RADIO | Built an HTTP proxy at `/stream/wcrb` that correctly serves 192kbps MP3 from CDN. Speaker connects to port 8080 WebSocket fine but never requested the stream — confirms LOCAL_INTERNET_RADIO is cloud-dependent. |
| `GET /WebSocket` path for boseWatcher WebSocket | Correct path is `GET /` — libsoundtouch Python library uses `ws://<host>:<port>/`. The `/WebSocket` path caused immediate silent close. |
| WebSocket without User-Agent/Accept headers | libwebsockets on Bose speakers silently closes TCP connection if `User-Agent` and `Accept: */*` are absent. Standard WebSocket handshake headers alone are insufficient. |
| boseWatcher: wait for STANDBY after INVALID_SOURCE | Speaker stays in INVALID_SOURCE indefinitely after cloud failure — never transitions to STANDBY. Abandoned in favour of polling for INVALID_SOURCE transition directly. |
| boseWatcher: POWER key before MA play | Sent `POWER` key to clear stuck state; speaker didn't actually turn off but the sequence was unnecessary once WebSocket `nowSelectionUpdated` provided instant detection before cloud attempt. |
