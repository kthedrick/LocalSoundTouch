// GET /snapshot — capture now-playing status for all known speakers.
// Called automatically when a test is marked Fail.

const http  = require('http');
const https = require('https');
const speakerDiscovery = require('./speakerDiscovery');
const wiimDiscovery    = require('./wiimDiscovery');

const WIIM_AGENT = new https.Agent({ rejectUnauthorized: false });
const TIMEOUT_MS = 2500;

function boseGet(ip) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: ip, port: 8090, path: '/now_playing', method: 'GET' },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); }
    );
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function wiimGet(ip) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: ip, port: 443, path: '/httpapi.asp?command=getPlayerStatus',
        method: 'GET', agent: WIIM_AGENT },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); }
    );
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function xmlField(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
  return m ? m[1].trim() : null;
}
function xmlAttr(xml, tag, attr) {
  const m = xml.match(new RegExp(`<${tag}[^>\\n]*?${attr}="([^"]*)"`));
  return m ? m[1] : null;
}

function hexDecode(s) {
  if (!s || s === 'none' || !/^[0-9a-fA-F]+$/.test(s) || s.length % 2 !== 0) return s || null;
  try { return Buffer.from(s, 'hex').toString('utf8'); } catch { return s; }
}

function wiimMode(mode) {
  const m = parseInt(mode);
  if ([1, 47, 48, 49].includes(m)) return 'AIRPLAY';
  if ([3, 31].includes(m))         return 'SPOTIFY';
  if (m === 2)  return 'DLNA';
  if (m === 40) return 'AUX';
  if (m === 41) return 'BLUETOOTH';
  if (m === 43) return 'OPTICAL';
  if (m === 0 || m === 10 || m === 99) return null;
  return 'WIIM';
}

async function boseSnapshot(spk) {
  const xml    = await boseGet(spk.ip);
  const source = xmlAttr(xml, 'nowPlaying', 'source') || 'UNKNOWN';
  const play   = xmlField(xml, 'playStatus') || 'STOP_STATE';
  const result = { name: spk.name, source, playStatus: play };
  if (source !== 'STANDBY') {
    const track   = xmlField(xml, 'track');
    const artist  = xmlField(xml, 'artist');
    const station = xmlField(xml, 'stationName');
    const vol     = xmlField(xml, 'volume') || xmlAttr(xml, 'volume', 'actual');
    if (track)   result.track   = track;
    if (artist)  result.artist  = artist;
    if (station) result.station = station;
    if (vol)     result.volume  = vol;
  }
  return result;
}

async function wiimSnapshot(spk) {
  const d      = await wiimGet(spk.ip);
  const source = wiimMode(d.mode);
  const play   = d.status === 'play' ? 'PLAY_STATE' : d.status === 'pause' ? 'PAUSE_STATE' : 'STOP_STATE';
  const result = { name: spk.name, source: source || 'IDLE', playStatus: play };
  if (source) {
    const track  = hexDecode(d.Title);
    const artist = hexDecode(d.Artist);
    if (track)  result.track  = track;
    if (artist) result.artist = artist;
    if (d.vol)  result.volume = d.vol;
  }
  return result;
}

module.exports = async function handleSnapshot(req, res) {
  const boseSpeakers = speakerDiscovery.getSpeakers();
  const wiimSpeakers = (wiimDiscovery.getDiscovery().wiims || []).map(w => ({ ...w, brand: 'wiim' }));
  const speakers = [...boseSpeakers, ...wiimSpeakers];
  const settled  = await Promise.allSettled(
    speakers.map(spk =>
      spk.brand === 'wiim' ? wiimSnapshot(spk) : boseSnapshot(spk)
    )
  );
  const snapshot = settled.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { name: speakers[i]?.name, error: r.reason?.message || 'failed' }
  );
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(snapshot));
};

// exported for tests
module.exports.xmlField = xmlField;
module.exports.xmlAttr = xmlAttr;
module.exports.hexDecode = hexDecode;
module.exports.wiimMode = wiimMode;
