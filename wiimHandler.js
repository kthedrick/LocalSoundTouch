const https = require('https');

const TIMEOUT_MS = 5000;

const AGENT = new https.Agent({ rejectUnauthorized: false });

function wiimGet(ip, command) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: ip, port: 443,
      path: '/httpapi.asp?command=' + command,
      method: 'GET',
      agent: AGENT,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function hexDecode(s) {
  if (!s || s === 'none' || !/^[0-9a-fA-F]+$/.test(s) || s.length % 2 !== 0) {
    return (s === 'none' || !s) ? null : s;
  }
  try { s = Buffer.from(s, 'hex').toString('utf8'); }
  catch { return s; }
  // WiiM echoes XML entities literally — decode them
  return s.replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
}

function modeToSource(mode) {
  const m = parseInt(mode);
  if ([1, 47, 48, 49].includes(m)) return 'AIRPLAY';
  if ([3, 31].includes(m))         return 'SPOTIFY';
  if (m === 2)                     return 'DLNA';
  if (m === 40)                    return 'AUX';
  if (m === 41)                    return 'BLUETOOTH';
  if (m === 43)                    return 'OPTICAL';
  if (m === 51)                    return 'USB';
  if (m === 0 || m === 10 || m === 99) return null; // idle
  return 'WIIM';
}

async function getStatus(ip) {
  const d = await wiimGet(ip, 'getPlayerStatus');
  const source   = modeToSource(d.mode);
  const track    = hexDecode(d.Title);
  const artist   = hexDecode(d.Artist);
  const playStatus = d.status === 'play'  ? 'PLAY_STATE'
                   : d.status === 'pause' ? 'PAUSE_STATE'
                   :                        'STOP_STATE';
  return {
    volume:     parseInt(d.vol) || 0,
    muted:      d.mute === '1',
    playStatus,
    nowPlaying: source ? {
      source, track, artist, stationName: null, art: null,
      duration: Math.round(parseInt(d.totlen || '0') / 1000),
      position: Math.round(parseInt(d.curpos || '0') / 1000),
    } : null,
  };
}

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

module.exports = async function handleWiim(req, res) {
  const url     = new URL(req.url, 'http://localhost');
  const urlPath = url.pathname;
  try {
    if (urlPath === '/wiim/test') {
      const ip = url.searchParams.get('ip');
      if (!ip) { res.writeHead(400); res.end('ip required'); return; }
      try {
        const raw = await wiimGet(ip, 'getPlayerStatus');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, raw }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (urlPath === '/wiim/status') {
      const ip = url.searchParams.get('ip');
      if (!ip) { res.writeHead(400); res.end('ip required'); return; }
      const status = await getStatus(ip);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    const body = JSON.parse(await readBody(req));
    const ip   = body.ip;
    if (!ip) { res.writeHead(400); res.end('ip required'); return; }

    if (urlPath === '/wiim/volume') {
      await wiimGet(ip, 'setPlayerCmd:vol:' + Math.round(body.volume));
      res.writeHead(200); res.end('ok');
      return;
    }

    if (urlPath === '/wiim/mute') {
      await wiimGet(ip, 'setPlayerCmd:mute:' + (body.muted ? '1' : '0'));
      res.writeHead(200); res.end('ok');
      return;
    }

    if (urlPath === '/wiim/key') {
      const map = {
        PLAY_PAUSE: 'setPlayerCmd:onepause',
        NEXT_TRACK: 'setPlayerCmd:next',
        PREV_TRACK: 'setPlayerCmd:prev',
      };
      const command = map[body.key];
      if (command) await wiimGet(ip, command);
      res.writeHead(200); res.end('ok');
      return;
    }

    res.writeHead(404); res.end('Not found');
  } catch (err) {
    console.error('[WiiM]', err.message);
    if (!res.headersSent) { res.writeHead(500); res.end(err.message); }
  }
};
