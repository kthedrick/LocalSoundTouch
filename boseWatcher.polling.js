// boseWatcher.js — polls Bose speakers for INVALID_SOURCE and plays MA fallback
// Uses HTTP polling via our existing proxy instead of WebSocket (speakers silently drop WS).
// To disable: comment out require('./boseWatcher') in main.js.
//
// haConfig.json: "invalidSourceFallback": { "uri": "library://radio/1" }
// Per-speaker:   "invalidSourceFallback": { "uri": "...", "Bose-Bathroom": { "uri": "..." } }

const http = require('http');
const { getConfig } = require('./maClient');

const POLL_MS      = 4000;
const lastSource   = {}; // speakerName → last known source

function getNowPlaying(ip) {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: ip, port: 8090, path: '/now_playing', method: 'GET', timeout: 3000 },
      (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          const m = data.match(/nowPlaying[^>]+source="([^"]+)"/);
          resolve(m ? m[1] : null);
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function boseStop(ip) {
  const xml = '<key state="press" sender="Gabbo">STOP</key>';
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: ip, port: 8090, path: '/key', method: 'POST',
        headers: { 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(xml) } },
      res => { res.resume(); resolve(); }
    );
    req.on('error', () => resolve());
    req.write(xml);
    req.end();
  });
}

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

function pollSpeaker(ip, name) {
  setInterval(async () => {
    const source = await getNowPlaying(ip);
    if (source === null) return; // unreachable, skip

    const prev = lastSource[name];
    lastSource[name] = source;

    // On first INVALID_SOURCE: stop the stuck preset, then play fallback
    if (source === 'INVALID_SOURCE' && prev !== 'INVALID_SOURCE') {
      const cfg     = getConfig();
      const fallback = cfg.invalidSourceFallback;
      if (!fallback) return;
      const uri     = fallback[name]?.uri || fallback.uri;
      const queueId = cfg.speakerQueues?.[name];
      if (!uri || !queueId) return;
      console.log(`[boseWatcher] ${name}: INVALID_SOURCE → stopping then playing ${uri}`);
      boseStop(ip)
        .then(() => new Promise(r => setTimeout(r, 1500)))
        .then(() => haPlay(queueId, uri))
        .then(() => console.log(`[boseWatcher] ${name}: play sent`))
        .catch(e => console.error(`[boseWatcher] ${name}: play failed:`, e.message));
    }

  }, POLL_MS);
}

function start(speakers) {
  for (const { ip, name } of speakers) {
    pollSpeaker(ip, name);
  }
  console.log(`[boseWatcher] polling ${speakers.length} speaker(s) every ${POLL_MS}ms`);
}

module.exports = { start };
