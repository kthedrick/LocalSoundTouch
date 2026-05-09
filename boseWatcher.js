// boseWatcher.js — Bose speaker watcher with WebSocket + polling fallback
//
// Primary: WebSocket on port 8080 — fires instantly on nowSelectionUpdated (preset press)
// Fallback: HTTP poll every 8s — catches INVALID_SOURCE if WebSocket fails
//
// haConfig.json:
//   "presetActions": {
//     "Bose-Bathroom": { "5": "library://radio/1" },
//     "Bose-Joshua":   { "5": "library://radio/1" }
//   }
//   "invalidSourceFallback": { "uri": "library://radio/1" }   ← polling fallback
//
// To revert to polling-only: replace this file with boseWatcher.polling.js

const net    = require('net');
const http   = require('http');
const crypto = require('crypto');
const { getConfig } = require('./maClient');

const WS_PORT      = 8080;
const RECONNECT_MS = 20000;
const POLL_MS      = 15000;

const lastSource = {}; // name → last polled source (for fallback)

// ── Bose HTTP helpers ──────────────────────────────────────────────────────────

function haPlay(queueId, uri) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ queueId, uri });
    const req  = http.request({
      hostname: 'localhost', port: 3000, path: '/ha/play', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function playFallback(ip, name, uri) {
  console.log(`[boseWatcher] ${name}: playing ${uri}`);
  const cfg     = getConfig();
  const queueId = cfg.speakerQueues?.[name];
  if (!queueId) { console.warn(`[boseWatcher] ${name}: no queueId`); return; }
  haPlay(queueId, uri)
    .then(() => console.log(`[boseWatcher] ${name}: play sent`))
    .catch(e => console.error(`[boseWatcher] ${name}: play failed:`, e.message));
}

// ── WebSocket frame parser ─────────────────────────────────────────────────────

function parseFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const opcode   = buf[offset] & 0x0f;
    const masked   = (buf[offset + 1] & 0x80) !== 0;
    let payloadLen = buf[offset + 1] & 0x7f;
    let headerLen  = 2;
    if (payloadLen === 126) {
      if (offset + 4 > buf.length) break;
      payloadLen = buf.readUInt16BE(offset + 2); headerLen = 4;
    } else if (payloadLen === 127) {
      if (offset + 10 > buf.length) break;
      payloadLen = buf.readUInt32BE(offset + 6); headerLen = 10;
    }
    if (masked) headerLen += 4;
    if (offset + headerLen + payloadLen > buf.length) break;
    if (opcode === 0x1 || opcode === 0x0) {
      let payload = buf.slice(offset + headerLen, offset + headerLen + payloadLen);
      if (masked) {
        const mask = buf.slice(offset + headerLen - 4, offset + headerLen);
        payload    = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
      }
      frames.push(payload.toString('utf8'));
    }
    offset += headerLen + payloadLen;
  }
  return { frames, remaining: buf.slice(offset) };
}

// ── WebSocket event handler ───────────────────────────────────────────────────

function handleWsEvent(ip, name, xml) {
  // nowSelectionUpdated: fires instantly when user presses a preset button
  if (xml.includes('nowSelectionUpdated')) {
    const m = xml.match(/<preset[^>]+id="(\d+)"/);
    if (!m) return;
    const presetId = m[1];
    const cfg      = getConfig();
    const uri      = cfg.presetActions?.[name]?.[presetId];
    if (!uri) return;
    console.log(`[boseWatcher] ${name}: preset ${presetId} pressed → playing ${uri}`);
    playFallback(ip, name, uri);
    return;
  }

  // nowPlayingUpdated: track source changes for fallback logic
  if (xml.includes('nowPlayingUpdated')) {
    const m = xml.match(/<nowPlaying[^>]+source="([^"]+)"/);
    if (m) lastSource[name] = m[1];
  }
}

// ── WebSocket connection ──────────────────────────────────────────────────────

function watchSpeakerWs(ip, name) {
  let buf = Buffer.alloc(0), handshakeDone = false, reconnectTimer;

  function connect() {
    buf = Buffer.alloc(0); handshakeDone = false;

    const socket = net.createConnection({ host: ip, port: WS_PORT }, () => {
      const key  = crypto.randomBytes(16).toString('base64');
      const hs   = [
        'GET / HTTP/1.1',
        `Host: ${ip}:${WS_PORT}`,
        'User-Agent: LocalSoundTouch/1.0',
        'Accept: */*',
        'Upgrade: websocket',
        `Origin: http://${ip}:${WS_PORT}`,
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Protocol: gabbo',
        'Connection: Upgrade',
        '', '',
      ].join('\r\n');
      socket.write(hs);
    });

    socket.on('data', chunk => {
      try {
        buf = Buffer.concat([buf, chunk]);
        if (!handshakeDone) {
          const str = buf.toString('ascii');
          const end = str.indexOf('\r\n\r\n');
          if (end === -1) return;
          if (!str.includes('101')) {
            console.log(`[boseWatcher] ${name}: WS rejected: ${str.slice(0, 80).replace(/\r\n/g,'|')}`);
            socket.destroy(); return;
          }
          handshakeDone = true;
          buf = buf.slice(end + 4);
          console.log(`[boseWatcher] ${name}: WS connected`);
        }
        const { frames, remaining } = parseFrames(buf);
        buf = remaining;
        for (const xml of frames) handleWsEvent(ip, name, xml);
      } catch (e) {
        console.error(`[boseWatcher] ${name}: frame error:`, e.message);
      }
    });

    socket.on('error', () => {});
    socket.on('close', () => {
      if (handshakeDone) console.log(`[boseWatcher] ${name}: WS disconnected`);
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, RECONNECT_MS);
    });
  }

  connect();
}

// ── Polling fallback ──────────────────────────────────────────────────────────
// Catches INVALID_SOURCE when WS is disconnected or preset not in presetActions.
// Uses its own prev tracking so WS state updates don't interfere.

function confirmAndFallback(ip, name) {
  // Re-check after a delay: if still INVALID_SOURCE, fire fallback.
  // This prevents false triggers during the transient INVALID_SOURCE that
  // Bose speakers emit while powering off (they settle to STANDBY within seconds).
  const req = http.request(
    { hostname: ip, port: 8090, path: '/now_playing', method: 'GET', timeout: 3000 },
    (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        const m   = data.match(/nowPlaying[^>]+source="([^"]+)"/);
        const cur = m ? m[1] : null;
        if (cur !== 'INVALID_SOURCE') {
          console.log(`[boseWatcher] ${name}: INVALID_SOURCE cleared (power-off), skipping fallback`);
          return;
        }
        // invalidSourceFallback: candidate for removal — presetActions now handles
        // WCRB directly, so this fallback has no remaining legitimate use case.
        // Re-enable by adding "invalidSourceFallback": { "uri": "..." } to haConfig.json.
        const cfg      = getConfig();
        const fallback = cfg.invalidSourceFallback;
        if (!fallback) return;
        const uri = fallback[name]?.uri || fallback.uri;
        if (!uri) return;
        console.log(`[boseWatcher] ${name}: INVALID_SOURCE confirmed → ${uri}`);
        playFallback(ip, name, uri);
      });
    }
  );
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end();
}

function pollSpeaker(ip, name) {
  let prev            = null;
  let pendingFallback = null;

  setInterval(() => {
    const req = http.request(
      { hostname: ip, port: 8090, path: '/now_playing', method: 'GET', timeout: 3000 },
      (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          const m      = data.match(/nowPlaying[^>]+source="([^"]+)"/);
          const source = m ? m[1] : null;
          if (!source) return;
          const last = prev;
          prev = source;

          if (source !== 'INVALID_SOURCE') {
            if (pendingFallback) { clearTimeout(pendingFallback); pendingFallback = null; }
            return;
          }

          // Entered INVALID_SOURCE — wait 6s then confirm before firing fallback
          if (last !== 'INVALID_SOURCE' && !pendingFallback) {
            pendingFallback = setTimeout(() => {
              pendingFallback = null;
              confirmAndFallback(ip, name);
            }, 6000);
          }
        });
      }
    );
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.end();
  }, POLL_MS);
}

// ── Entry point ───────────────────────────────────────────────────────────────

function start(speakers) {
  for (const { ip, name } of speakers) {
    watchSpeakerWs(ip, name);
    pollSpeaker(ip, name);
  }
  console.log(`[boseWatcher] watching ${speakers.length} speakers (WS + poll)`);
}

module.exports = { start };
