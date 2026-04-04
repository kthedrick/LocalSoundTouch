# Bose SoundTouch Controller — Project Context Document

*Created for transfer to Claude Code. Last updated: April 2026.*

---

## Project Overview

A custom local web controller for a 10-speaker Bose SoundTouch whole-home audio system, built to replace the official Bose SoundTouch app after Bose shut down its cloud service on **May 6, 2026**. The controller provides full local control without any cloud dependency.

**Architecture:** Node.js HTTP proxy server + React frontend (embedded in the Node.js server as a string constant) served at `http://localhost:3000`.

The proxy is necessary because SoundTouch speakers don't send CORS headers, so browser-based fetch calls to `http://<speaker-ip>:8090` are blocked. The Node.js server proxies all API calls.

---

## Speaker Inventory

| Name | IP Address |
|------|------------|
| Sunroom | 192.168.1.229 |
| Office | 192.168.1.164 |
| Bathroom | 192.168.1.247 |
| Rosemary | 192.168.1.36 |
| Joshua | 192.168.1.94 |
| Living Room | 192.168.1.171 |
| Kitchen | 192.168.1.185 |
| Main Bedroom | 192.168.1.176 |
| Dining Room | 192.168.1.62 |
| Patio | 192.168.1.13 |

**Notable device:** The **Sunroom** speaker (`192.168.1.229`, device ID `B0D5CCCFCF13`) is a **SoundTouch 300** soundbar — it has a different capability set than the other speakers (no bass/treble controls via standard endpoints, has CEC/HDMI endpoints).

---

## SoundTouch REST API — Core Reference

All speakers run an HTTP server on **port 8090**. All commands are XML.

### Key GET Endpoints

```
GET /info                  → device info, device ID, name
GET /now_playing           → current track, artist, album, art URL, source
GET /volume                → <actualvolume>, <targetvolume>, <muteenabled>
GET /presets               → 6 preset slots with ContentItem details
GET /sources               → available sources (PANDORA, STORED_MUSIC, AIRPLAY, etc.)
GET /capabilities          → device-specific capability list (vary by model)
GET /zone                  → current zone/group membership
GET /browse                → browse media library (POST with ContentItem)
```

### Key POST Endpoints

```
POST /volume               → <volume>50</volume>
POST /key                  → key press/release (see Key Commands below)
POST /select               → select a ContentItem to play
POST /createZone           → create a speaker group (zone)
POST /addZoneSlaves        → add speakers to existing zone
POST /removeZoneSlaves     → remove speakers from zone
POST /browse               → browse STORED_MUSIC or other sources
```

### Key Command Pattern

```xml
<!-- Press -->
POST /key
<key state="press" sender="Gabbo">PLAY</key>

<!-- Release (send ~100ms after press) -->
POST /key
<key state="release" sender="Gabbo">PLAY</key>
```

**Valid key values:** `PLAY`, `PAUSE`, `PLAY_PAUSE`, `STOP`, `PREV_TRACK`, `NEXT_TRACK`, `MUTE`, `POWER`, `PRESET_1` through `PRESET_6`, `VOLUME_UP`, `VOLUME_DOWN`

### Zone (Group) Control

```xml
<!-- Create zone — master is the speaker receiving the POST -->
POST http://192.168.1.171:8090/createZone
<zone master="192.168.1.171">
  <member ipaddress="192.168.1.185">192.168.1.185</member>
  <member ipaddress="192.168.1.176">192.168.1.176</member>
</zone>

<!-- The master IP must be included in the member list -->
```

### Playing a Preset

```xml
POST /select
<ContentItem source="PRESET" sourceAccount="" isPresetable="true">
  <itemName>Preset 1</itemName>
  <containerArt></containerArt>
</ContentItem>
```

### Browsing Stored Music (NAS)

```xml
POST /browse
<ContentItem source="STORED_MUSIC" type="dir" location="" 
             sourceAccount="4d696e69-444c-164e-9d41-c46e1faa21b9/0">
  <itemName>Music Library</itemName>
</ContentItem>
```

**NAS Account ID:** `4d696e69-444c-164e-9d41-c46e1faa21b9/0`  
Use this exact value for all STORED_MUSIC browse and play calls.

---

## Discovered Undocumented Endpoints (SoundTouch 300 only)

Found by querying `/capabilities` on the Sunroom (SoundTouch 300). These do **not** appear in Bose's official API documentation:

| Endpoint | Purpose |
|----------|---------|
| `/productcechdmicontrol` | HDMI-CEC mode control |
| `/producthdmiassignmentcontrols` | HDMI input label assignments |
| `/audiospeakerattributeandsetting` | Speaker attribute/EQ settings |
| `/audiodspcontrols` | DSP audio mode controls |
| `/audioproducttonecontrols` | Tone controls (bass/treble for soundbar) |
| `/audioproductlevelcontrols` | Surround speaker level controls |
| `/systemtimeoutcontrol` | Power saving timeout |
| `/rebroadcastlatencymode` | Multi-room latency tuning |

**CEC control example:**
```xml
GET /productcechdmicontrol
→ <productcechdmicontrol cecmode="CEC_MODE_ON" />

POST /productcechdmicontrol
<productcechdmicontrol cecmode="CEC_MODE_OFF" />
```

Note: CEC control was ultimately abandoned during development — the SoundTouch 300 accepts the command but the practical benefit was unclear.

---

## LOCAL_INTERNET_RADIO (Post-Cloud Streaming)

After the Bose cloud shutdown, internet radio stations can still be played using `LOCAL_INTERNET_RADIO` with a hosted JSON file. This was a key discovery for post-May 2026 viability.

**How it works:**

1. Host a JSON file describing the stream (e.g., on Home Assistant's `/config/www/` directory, accessible at `http://HA_IP:8123/local/wcrb.json`):

```json
{
  "audio": {
    "hasPlaylist": false,
    "isRealtime": true,
    "streamUrl": "http://audio.wgbh.org:8004/"
  },
  "imageUrl": "https://example.com/logo.png",
  "name": "WCRB 99.5",
  "streamType": "liveRadio"
}
```

2. Play it via the API:

```xml
POST /select
<ContentItem source="LOCAL_INTERNET_RADIO" location="http://HA_IP:8123/local/wcrb.json">
  <itemName>WCRB 99.5</itemName>
</ContentItem>
```

**Home Assistant static file path:** `/config/www/` → accessible at `http://homeassistant:8123/local/`

---

## Application Architecture

### File: `bose-proxy.js`

A single Node.js file that:
- Starts an HTTP server on port 3000
- Proxies `/api/<speaker-ip><endpoint>` to `http://<speaker-ip>:8090<endpoint>`
- Serves the entire React frontend as an inline HTML string constant (`HTML_CONTENT`)
- The frontend uses Babel standalone + React 18 UMD builds loaded from unpkg CDN
- Tailwind CSS loaded from CDN

### Frontend State (React)

Key state variables in the React app:
- `selectedSpeaker` — current speaker object `{ip, name}`
- `groupedSpeakers` — array of additional speakers in the current zone
- `volume` — integer 0–100
- `nowPlaying` — `{artist, track, album, source, art}`
- `presets` — array of `{id, name}`
- `sources` — array of available sources
- `mediaItems` / `currentMediaPath` — for STORED_MUSIC browser
- `apiCallHistory` — last 2 API calls shown in debug panel

### Key Functions

- `sendCommand(speaker, endpoint, method, body)` — fetches via proxy
- `sendGroupCommand(endpoint, method, body)` — sends to selected speaker + all grouped speakers
- `fetchNowPlaying()` — polls every 5 seconds when connected
- `browseMedia(location)` — browse STORED_MUSIC with the NAS account ID hardcoded
- `playMedia(item)` — plays a browsed item
- `createZone()` / group management

---

## Features Implemented

- [x] 10-speaker selection grid
- [x] Now Playing display (art, track, artist, album, source)
- [x] Playback controls (power, prev, play/pause, next)
- [x] Volume slider (0–100)
- [x] Preset buttons (up to 6)
- [x] Speaker grouping / zone creation UI
- [x] Stored music (NAS) browser modal
- [x] Source listing
- [x] API debug panel (last 2 calls shown)
- [x] Auto-refresh now playing (5-second interval)

## Features NOT Implemented / Known Gaps

- [ ] Bass/treble controls (standard speakers — endpoint works but not wired to UI)
- [ ] CEC control (abandoned — commands accepted but behavior unclear)
- [ ] LOCAL_INTERNET_RADIO station management UI
- [ ] WebSocket support (SoundTouch supports WebSocket on port 8080 for push notifications — currently using polling)
- [ ] Persistent zone/group state across page reloads
- [ ] Multi-speaker status dashboard (see all 10 at once)
- [ ] Quick actions (pause all, volume sync across all speakers)
- [ ] Sleep timer
- [ ] Favorite group presets

---

## What Works Post-Cloud Shutdown

| Feature | Status |
|---------|--------|
| All documented REST API endpoints | ✅ Works locally |
| Zone (multi-room) control | ✅ Works locally |
| AUX, Bluetooth, AirPlay inputs | ✅ Works locally |
| NAS stored music library | ✅ Works locally |
| LOCAL_INTERNET_RADIO (via JSON) | ✅ Works locally |
| Pandora, Spotify, Amazon Music | ❌ Cloud-dependent, dead |
| TuneIn | ❌ Cloud-dependent, dead |
| Official Bose SoundTouch app | ❌ Dead |

---

## How to Find the Code on Your Computer

The app was developed iteratively in claude.ai artifacts (chat ID: `46b85747-d992-4d11-a247-ecc7dba302ae`). The final code **was not saved to disk as a finished file** during those sessions — it lived as an artifact. 

**To find it, check these locations:**

1. **Downloads folder** — if you ever downloaded the artifact, look for `bose-proxy.js` or similar
2. **Wherever you ran it** — since you ran `node bose-proxy.js` during testing, check:
   - `~/bose/`
   - `~/projects/bose/`
   - `~/soundtouch/`
   - Desktop or Documents
3. **Search command (run in Terminal):**
   ```bash
   find ~ -name "bose-proxy*" 2>/dev/null
   find ~ -name "*soundtouch*" 2>/dev/null
   find ~ -name "*bose*" -name "*.js" 2>/dev/null
   ```

**If you can't find it:** The full code can be reconstructed from the claude.ai conversation history at:
`https://claude.ai/chat/46b85747-d992-4d11-a247-ecc7dba302ae`

The final version of the artifact was named `bose-proxy-server` and contained both the Node.js proxy code AND the embedded React frontend HTML as a string constant.

---

## Suggested Claude Code Enhancement Ideas

When bringing this into Claude Code, consider:

1. **Split into proper files** — separate `server.js`, `public/index.html`, `public/app.jsx`
2. **WebSocket listener** — connect to `ws://<speaker-ip>:8080/WebSocket` for push updates instead of polling
3. **Proper React build** — use Vite or CRA instead of Babel standalone (CDN)
4. **Station manager** — UI to manage LOCAL_INTERNET_RADIO JSON files hosted on Home Assistant
5. **Multi-speaker dashboard** — see all 10 speakers' status simultaneously
6. **Home Assistant integration** — call HA REST API or webhooks from the controller
7. **Persist settings** — save preferred groups, last-used speaker, etc.

---

## Related Chat Conversations

| Chat | URL | Topic |
|------|-----|-------|
| Main development | https://claude.ai/chat/46b85747-d992-4d11-a247-ecc7dba302ae | Full app build, proxy, stored music |
| API exploration | https://claude.ai/chat/ae2d0c68-495c-4c9b-b93a-2efe00840442 | Undocumented endpoints, LOCAL_INTERNET_RADIO discovery |
| Post-shutdown research | https://claude.ai/chat/13f3542f-88ff-4370-a17e-4cc1f08f0baa | Bose Music platform comparison |
