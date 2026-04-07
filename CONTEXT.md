# LocalSoundTouch — Project Context

## What This Is

A custom Bose SoundTouch controller built to replace functionality lost as Bose deprecates their cloud content API. Runs as a Node.js HTTP server with a React/Tailwind UI, served to any browser on the LAN.

**Deployment target:** Docker container running inside Home Assistant on a Raspberry Pi, alongside (not replacing) HA.

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

### UI (`public/js/app2.jsx`)
- React 18 UMD + Babel standalone (no build step)
- Tailwind CDN
- `AllSpeakersView` polls all speakers every 15s, builds zone groups from `/getZone` responses
- `GroupCard` shows now-playing, volume controls, presets, Include/SyncTo, and NAS browser button
- `NasBrowserModal` — FTP folder browser with shuffle toggle, queues tracks via `/upnp/queue`

#### Key Bose API quirk
`/getZone` sometimes returns empty `senderIPAddress`. Fix: when `senderIPAddress` is empty but members exist, infer master IP = the queried speaker's IP.

---

## Speaker IPs
| Speaker | IP |
|---------|-----|
| Sunroom | 192.168.1.229 |
| Living Room | 192.168.1.171 |
| Kitchen | (discovered dynamically) |

Sunroom is always sorted first in the UI.

---

## Future TODOs

### Server-side WebSocket subscription (queue improvement)
**Current:** queue advances by polling `GetTransportInfo` every 3s via UPnP SOAP.  
**Better:** open a WebSocket connection from the Node.js server to each speaker at `ws://<ip>:8080` and listen for `nowPlayingUpdated` events. When `playStatus` becomes `STOP_STATE` (source=UPnP), advance the queue immediately with no polling overhead.  
**Why not done yet:** requires implementing a WebSocket client handshake from scratch in Node.js `net` module (~50 lines) since we avoid npm. Low priority — 3s polling works fine on Raspberry Pi.

### Pandora
Pandora does not offer an open developer API for first-class integration (requires becoming an official partner). **Strategy:** let Home Assistant handle Pandora playback. HA can launch Pandora via its integration and push audio to speakers via UPnP. This UI can detect when a speaker is playing HA/UPnP content and show appropriate controls (play/pause/skip via Bose key API still works).

### Docker containerization
- Will run as a Docker container inside HA on Raspberry Pi
- `nasConfig.json` should be mounted as a volume (not baked into image)
- Ports needed: 3000 (HTTP), and UDP for SSDP discovery (or use host networking)
- Consider `network_mode: host` to simplify SSDP multicast and UPnP discovery

### Potential future features
- Pandora source detection + HA passthrough controls
- Per-speaker EQ or bass/treble controls (Bose API supports these)
- Alarm / scheduled playback
- Track history / recently played

---

## What Was Tried and Abandoned

| Approach | Why Abandoned |
|----------|--------------|
| SMB for NAS access | Windows 11 disables SMBv1; TP-Link only supports SMBv1 |
| `LOCAL_INTERNET_RADIO` source via Bose `/select` | Speaker accepted the request (200 OK) but never fetched the descriptor URL — not supported on this model |
| M3U playlist via UPnP | UPnP AVTransport doesn't natively handle M3U playlists — replaced with server-side queue |
| Browser-side queue management | Requires browser tab to stay open; incompatible with Docker/always-on server use case |
| Pure Home Assistant UI (Lovelace) | Inflexible for a polished, family-friendly interface |
