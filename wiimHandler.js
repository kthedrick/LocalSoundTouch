const https         = require('https');
const { getDiscovery } = require('./wiimDiscovery');

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

const artCache = new Map(); // key: "artist|track" → url or null

async function lookupArt(artist, track) {
  const key = `${artist}|${track}`;
  if (artCache.has(key)) return artCache.get(key);
  try {
    const q = encodeURIComponent(`${artist} ${track}`);
    const url = await new Promise((resolve) => {
      const req = https.get(`https://itunes.apple.com/search?term=${q}&media=music&entity=song&limit=1`, (res) => {
        let d = '';
        res.on('data', chunk => { d += chunk; });
        res.on('end', () => {
          try {
            const art = JSON.parse(d)?.results?.[0]?.artworkUrl100?.replace('100x100bb', '300x300bb') || null;
            resolve(art);
          } catch { resolve(null); }
        });
      });
      req.setTimeout(3000, () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
    });
    artCache.set(key, url);
    return url;
  } catch {
    artCache.set(key, null);
    return null;
  }
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
  const album    = hexDecode(d.Album);
  const art = (track && artist) ? await lookupArt(artist, track) : null;
  const playStatus = d.status === 'play'  ? 'PLAY_STATE'
                   : d.status === 'pause' ? 'PAUSE_STATE'
                   :                        'STOP_STATE';
  return {
    volume:     parseInt(d.vol) || 0,
    muted:      d.mute === '1',
    playStatus,
    nowPlaying: source ? {
      source, track, artist, album, stationName: null, art,
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
    if (urlPath === '/wiim/discover') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getDiscovery()));
      return;
    }

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

    // POST /wiim/ungroup { ip } — dissolve any native WiiM multiroom group the speaker is in
    // Must happen before adding a WiiM to an AirPlay group via MA, otherwise MA grouping acts weird.
    if (urlPath === '/wiim/ungroup') {
      try {
        const status = await wiimGet(ip, 'getStatusEx');
        const group = String(status?.group ?? '0');
        if (group === '1') {
          // This device is the multiroom master — dissolve the whole group
          await wiimGet(ip, 'multiroom:Ungroup').catch(() => {});
          console.log('[WiiM/ungroup] %s was master → Ungroup sent', ip);
        } else if (group === '2') {
          // This device is a slave — ungroup via master IP if available, else try on self
          const masterIp = status.master_ip || null;
          if (masterIp) {
            await wiimGet(masterIp, 'multiroom:Ungroup').catch(() => {});
            console.log('[WiiM/ungroup] %s was slave → Ungroup sent to master %s', ip, masterIp);
          } else {
            await wiimGet(ip, 'multiroom:Ungroup').catch(() => {});
            console.log('[WiiM/ungroup] %s was slave (no master_ip) → Ungroup sent to self', ip);
          }
        } else {
          console.log('[WiiM/ungroup] %s standalone (group=%s) — nothing to do', ip, group);
        }
      } catch (e) {
        console.warn('[WiiM/ungroup] %s error (non-fatal): %s', ip, e.message);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404); res.end('Not found');
  } catch (err) {
    const connErr = err.code === 'EHOSTUNREACH' || err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.message === 'timeout';
    if (!connErr) console.error('[WiiM]', err.message);
    if (!res.headersSent) { res.writeHead(500); res.end(err.message); }
  }
};
