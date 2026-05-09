// wiimDiscovery.js — background subnet scan to detect WiiM speakers at new IPs
//
// Scans the server's /24 subnet via HTTPS port 443 (same as wiimGet) every 5 minutes.
// Uses getPlayerStatus to identify WiiM/LinkPlay devices (vol + mode fields).
// Results cached in memory; exposed via /wiim/discover endpoint.

const https  = require('https');
const os     = require('os');

const BATCH       = 40;   // concurrent probes
const TIMEOUT_MS  = 800;
const INTERVAL_MS = 5 * 60 * 1000;
const AGENT = new https.Agent({ rejectUnauthorized: false });

let cache   = { scannedAt: null, wiims: [] };
let running = false;

function getSubnet() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const parts = addr.address.split('.');
        if (parts.length === 4) return parts.slice(0, 3).join('.');
      }
    }
  }
  return '192.168.1';
}

function probe(ip) {
  return new Promise(resolve => {
    const req = https.request({
      hostname: ip, port: 443,
      path: '/httpapi.asp?command=getPlayerStatus',
      method: 'GET', agent: AGENT,
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          // WiiM/LinkPlay devices have numeric vol + mode fields
          if (typeof j.vol !== 'undefined' && typeof j.mode !== 'undefined') {
            resolve({ ip });
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
    });
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function scan() {
  if (running) return;
  running = true;
  try {
    const subnet = getSubnet();
    const wiims = [];
    for (let start = 1; start <= 254; start += BATCH) {
      const batch = [];
      for (let i = start; i < Math.min(start + BATCH, 255); i++) batch.push(`${subnet}.${i}`);
      const results = await Promise.all(batch.map(probe));
      results.forEach(r => { if (r) wiims.push(r); });
    }
    cache = { scannedAt: Date.now(), wiims };
    console.log(`[wiimDiscovery] scan done — found ${wiims.length} WiiM(s) at [${wiims.map(w => w.ip).join(', ')}]`);
  } catch (e) {
    console.error('[wiimDiscovery] error:', e.message);
  } finally {
    running = false;
  }
}

function getDiscovery() { return cache; }

function start() {
  scan();
  setInterval(() => scan().catch(() => {}), INTERVAL_MS);
}

module.exports = { start, getDiscovery };
