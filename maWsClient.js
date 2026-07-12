// Minimal MA WebSocket client for commands not available via REST API.
// MA REST API rejects players/player_sync and players/player_unsync ("Invalid Command").
// These commands work over WebSocket at ws://homeassistant:8095/ws.

const net    = require('net');
const crypto = require('crypto');

// Encode a JSON object as a masked WebSocket text frame (clients must mask)
function wsEncode(obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  const len     = payload.length;
  const maskKey = crypto.randomBytes(4);
  const masked  = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ maskKey[i % 4];

  let header;
  if (len < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x81;        // FIN + text opcode
    header[1] = 0x80 | len;  // MASK + length
    maskKey.copy(header, 2);
  } else {
    header = Buffer.alloc(8);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    maskKey.copy(header, 4);
  }
  return Buffer.concat([header, masked]);
}

// Extract complete WebSocket frames from a Buffer.
// Returns { frames: string[], rest: Buffer }
function wsDecode(buf) {
  const frames = [];
  let pos = 0;
  while (pos + 2 <= buf.length) {
    const masked     = (buf[pos + 1] & 0x80) !== 0;
    let   payloadLen = buf[pos + 1] & 0x7F;
    let   offset     = pos + 2;

    if (payloadLen === 126) {
      if (offset + 2 > buf.length) break;
      payloadLen = buf.readUInt16BE(offset); offset += 2;
    } else if (payloadLen === 127) {
      if (offset + 8 > buf.length) break;
      payloadLen = buf.readUInt32BE(offset + 4); offset += 8; // lower 32 bits
    }

    const maskKeyOffset = offset;
    if (masked) offset += 4;
    if (offset + payloadLen > buf.length) break;

    const payload = Buffer.from(buf.slice(offset, offset + payloadLen));
    if (masked) {
      for (let i = 0; i < payload.length; i++)
        payload[i] ^= buf[maskKeyOffset + (i % 4)];
    }
    frames.push(payload.toString('utf8'));
    pos = offset + payloadLen;
  }
  return { frames, rest: buf.slice(pos) };
}

// Send a single command over MA WebSocket and return the result.
function maWsCommand(command, args, { host, port, token }) {
  return new Promise((resolve, reject) => {
    const wsKey = crypto.randomBytes(16).toString('base64');
    let   buf   = Buffer.alloc(0);
    let   upgraded = false;
    let   settled  = false;

    const socket = net.createConnection({ host, port }, () => {
      const authParam = token ? `?access_token=${encodeURIComponent(token)}` : '';
      socket.write([
        `GET /ws${authParam} HTTP/1.1`,
        `Host: ${host}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${wsKey}`,
        'Sec-WebSocket-Version: 13',
        '', ''
      ].join('\r\n'));
    });

    const timer = setTimeout(() => finish(new Error('MA WebSocket timeout')), 10000);

    function finish(val) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      val instanceof Error ? reject(val) : resolve(val);
    }

    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);

      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        const statusLine = buf.slice(0, buf.indexOf('\r\n')).toString();
        if (!statusLine.includes('101')) {
          finish(new Error('WS upgrade failed: ' + statusLine));
          return;
        }
        upgraded = true;
        buf = buf.slice(end + 4);
        socket.write(wsEncode({ message_id: 1, command, args }));
      }

      const { frames, rest } = wsDecode(buf);
      buf = rest;
      for (const frame of frames) {
        try {
          const msg = JSON.parse(frame);
          if (msg.message_id === 1) {
            if (msg.error_code) {
              finish(new Error(`MA WS error [${msg.error_code}]: ${msg.details || ''}`));
            } else {
              finish(msg.result ?? { ok: true });
            }
            return;
          }
        } catch { /* ignore non-JSON or other event frames */ }
      }
    });

    socket.on('error', finish);
    socket.on('close', () => { if (!settled) finish(new Error('MA WebSocket closed unexpectedly')); });
  });
}

// Sync a player to follow another player's queue output.
// Use for WiiM-type players that have can_group_with: [] and cannot join AirPlay groups.
function maWsPlayerSync(playerId, targetPlayerId, opts) {
  return maWsCommand('players/player_sync', { player_id: playerId, target_player_id: targetPlayerId }, opts);
}

// Unsync a player (reverse of maWsPlayerSync).
function maWsPlayerUnSync(playerId, opts) {
  return maWsCommand('players/player_unsync', { player_id: playerId }, opts);
}

module.exports = { maWsPlayerSync, maWsPlayerUnSync };
