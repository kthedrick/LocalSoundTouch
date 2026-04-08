# LocalSoundTouch — Project Context

## What This Is

A custom Bose SoundTouch controller built to replace functionality lost as Bose deprecates their cloud content API. Runs as a Node.js HTTP server with a React/Tailwind UI, served to any browser on the LAN.

**Deployment target:** Docker container running as a local HA add-on inside Home Assistant OS on Raspberry Pi.

**Critical deadline:** Bose cloud shuts down **May 6, 2026** — presets pointing to cloud sources (Pandora, internet radio via Bose servers) will stop working after that date.

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
- `playMedia(queueId, uri)` — play a URI on a specific queue (option: 1 = replace + play immediately)
- `stopQueue`, `pauseQueue`, `resumeQueue`, `nextTrack`, `prevTrack`, `getAllQueues`
- Config (token, URL, queue IDs) read from `haConfig.json`

**`haHandler.js`** — HTTP routes for MA:
| Route | Purpose |
|-------|---------|
| `GET /ha/config` | Returns safe config (queues, favorites) for the UI |
| `GET /ha/queues` | Lists all MA queues (discovery/debug) |
| `POST /ha/stop` | Stop a queue `{ queueId }` |
| `POST /ha/pause` | Pause a queue |
| `POST /ha/resume` | Resume a queue |
| `POST /ha/next` | Next track |
| `POST /ha/prev` | Previous track |
| `POST /ha/play` | Play a URI on a queue `{ queueId, uri }` |
| `GET /ha/schema` | Proxy MA's OpenAPI schema (debug) |

**`haConfig.json`** (git-ignored) — MA configuration:
```json
{
  "maUrl": "http://localhost:8095",
  "maToken": "<long-lived MA token>",
  "queues": {
    "sunroom": "upb0d5cccfcf13",
    "livingRoom": "up304511da849b",
    "kitchen": "upf8369b11ce57",
    "bedroom": "up04a316bee3e0",
    "bathroom": "upapf4e11ee0766b",
    "diningRoom": "up3881d72fc987",
    "office": "upf45eab9402de",
    "patio": "upd8a98bcbc0f6",
    "joshuaBose": "upb0d5cc50ef39",
    "joshuaWiim": "up9cb8b438124c",
    "wiimBasement": "up00226c2e2da2",
    "airplayGroup": "syncgroup_q6vlw5pk"
  },
  "releaseToTV": ["Bose-Sunroom 300"],
  "speakerQueues": {
    "Bose-Sunroom 300": "upb0d5cccfcf13",
    "Bose-Living Room": "up304511da849b"
  },
  "favorites": [
    {
      "name": "Radiohead Radio",
      "icon": "📻",
      "defaultQueueId": "syncgroup_q6vlw5pk",
      "uri": "library://radio/2"
    }
  ]
}
```

**MA API details:**
- MA is in beta; REST endpoint is `POST http://localhost:8095/api` with `{ command, args }`
- Queue IDs for Bose speakers look like `upb0d5cccfcf13` (prefix = `up` + MAC fragment)
- AirPlay group ID: `syncgroup_q6vlw5pk`
- When Bose speakers play MA content, the Bose `/nowPlaying` source shows `AIRPLAY`
- `player_queues/play_media` with `option: 1` is supposed to replace queue and play immediately
- MA token is a long-lived JWT stored in HA → Settings → People → user → tokens

### UI (`public/js/app2.jsx`)
- React 18 UMD + Babel standalone (no build step)
- Tailwind CDN
- `AllSpeakersView` polls all speakers every 15s, builds zone groups from `/getZone` responses
- `GroupCard` shows now-playing, volume controls, presets, Include/SyncTo, and NAS browser button
- `NasBrowserModal` — FTP folder browser with shuffle toggle, queues tracks via `/upnp/queue`

#### Key behavioral details
- **Speaker identification:** All logic uses Bose speaker names (from `/info` API), not IPs. IPs can change; names are stable. Discovery maps IP→name at runtime.
- **Favorites (MA):** Shown in GroupCard when `haConfig.speakerQueues[master.name]` exists. One-tap plays the favorite's URI on that speaker's MA queue.
- **AIRPLAY source routing:** When `nowPlaying.source === 'AIRPLAY'`, skip/prev buttons route through MA (`/ha/next`, `/ha/prev`) instead of Bose key API, because Bose keys don't control MA-driven playback.
- **Release to TV:** Shown only on speakers listed in `haConfig.releaseToTV` (currently Sunroom 300). Stops the MA queue so HA doesn't aggressively restart playback when the soundbar switches to TV input.
- **Per-speaker power button (⏻):** Shown in the speaker header row of each zone card.
- **Sort order:** Sunroom 300 sorts first; other zones follow alphabetically.

#### Key Bose API quirk
`/getZone` sometimes returns empty `senderIPAddress`. Fix: when `senderIPAddress` is empty but members exist, infer master IP = the queried speaker's IP.

---

## Speaker List
| Speaker Name (Bose /info) | IP | MA Queue ID |
|---|---|---|
| Bose-Sunroom 300 | 192.168.1.229 | upb0d5cccfcf13 |
| Bose-Living Room | 192.168.1.171 | up304511da849b |
| Bose-Kitchen | 192.168.1.185 | upf8369b11ce57 |
| Bose-Office | 192.168.1.162 | upf45eab9402de |
| Bose-Bathroom | 192.168.1.120 | upapf4e11ee0766b |
| Bose-Rosemary | 192.168.1.40 | — |
| Bose-Joshua | 192.168.1.91 | upb0d5cc50ef39 |
| Bose-Bedroom | 192.168.1.176 | up04a316bee3e0 |
| Bose-Dining Room | 192.168.1.55 | up3881d72fc987 |
| Bose-Patio | 192.168.1.7 | upd8a98bcbc0f6 |

**Note:** Bose-Bedroom has no native AirPlay — uses an external AirPlay→Aux1 adapter. MA targets it via its Bose UPnP queue, not AirPlay.

Also present in MA (not in this app's speaker list yet):
- Joshua's WiiM (`up9cb8b438124c`)
- Basement WiiM (`up00226c2e2da2`)

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
- **haConfig.json** is git-ignored and NOT deployed by deploy.sh — it lives only on the Pi; update it manually via SSH if needed
- **MA reachable as `localhost`** — MA runs on the same Pi; Docker host networking makes `localhost:8095` work

---

## Future TODOs

### Immediate: Radiohead Radio button (IN PROGRESS)
The Pandora/Radiohead Radio button shows "started ✓" but playback doesn't reliably land on the target speaker. Current attempt: `player_queues/play_media` with `option: 1` (QueueOption enum value for replace+play). If that doesn't work, next approaches:
- Verify MA interprets `option: 1` as immediate play (not queue-only)
- Try calling `player_queues/play` after `play_media` (two-step)
- Use the MA WebSocket API instead of REST for state-aware sequencing

### MA speakerQueues expansion
Currently only Sunroom and Living Room have MA queue mappings in `haConfig.json`. Need to add mappings for Kitchen, Office, Bathroom, Dining Room, Patio, Joshua, Bedroom so favorites work on all speakers.

### Bose-Bedroom AirPlay workaround
Bedroom has no native AirPlay. External AirPlay→Aux1 adapter in use. MA targets it via UPnP (Bose queue). The AirPlay group (`syncgroup_q6vlw5pk`) does NOT include Bedroom.

### WiiM speaker support
WiiM devices are excellent UPnP renderers — NAS/UPnP playback stack works unchanged. What needs work:
- Volume, mute, now-playing: WiiM uses Linkplay HTTP API (different endpoints, JSON) instead of Bose port 8090 XML
- Zones/grouping: WiiM has its own multiroom protocol, not compatible with Bose `/setZone`
- Right approach: abstract speaker control into a per-brand adapter (Bose, WiiM) with common interface

### Server-side WebSocket subscription (queue improvement)
**Current:** queue advances by polling `GetTransportInfo` every 3s via UPnP SOAP.  
**Better:** open a WebSocket connection from Node.js server to each speaker at `ws://<ip>:8080` and listen for `nowPlayingUpdated` events. When `playStatus` becomes `STOP_STATE` (source=UPnP), advance the queue immediately.  
**Why not done yet:** requires implementing WebSocket client handshake in Node.js `net` module (~50 lines) since we avoid npm. Low priority — 3s polling works fine on Raspberry Pi.

### HA Ingress / HTTPS
Currently plain HTTP on LAN. Options: HA Ingress (HTTPS via HA's reverse proxy, but requires iframe-compatible UI), or Caddy/nginx on Pi. Not urgent.

### Scheduled playback / alarms
Post-May-6 stretch goal.

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
