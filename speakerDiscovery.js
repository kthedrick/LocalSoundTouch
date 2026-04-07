const http = require('http');
const os = require('os');

const DISCOVERY_PORT = 8090;
const DISCOVERY_TIMEOUT = 1200;
const CONCURRENCY = 24;

let discoveredSpeakers = [];
let lastDiscovery = 0;

function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function intToIp(int) {
  return [24, 16, 8, 0].map(shift => (int >>> shift) & 0xff).join('.');
}

function maskToPrefix(mask) {
  return mask.split('.').reduce((sum, octet) => {
    const bits = parseInt(octet, 10);
    return sum + ((bits >>> 0).toString(2).match(/1/g) || []).length;
  }, 0);
}

function getScanRange(address, netmask) {
  const ipInt = ipToInt(address);
  const prefix = maskToPrefix(netmask);
  if (prefix >= 31) return [];

  let networkBase;
  if (prefix <= 24) {
    networkBase = ipInt & 0xffffff00;
  } else {
    const hostMask = (1 << (32 - prefix)) - 1;
    networkBase = ipInt & ~hostMask;
  }

  const totalHosts = prefix <= 24 ? 254 : (1 << (32 - prefix)) - 2;
  if (totalHosts <= 0) return [];

  const start = networkBase + 1;
  return Array.from({ length: totalHosts }, (_, idx) => intToIp(start + idx));
}

function getLocalCandidates() {
  const interfaces = os.networkInterfaces();
  const candidates = new Set();

  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name]) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (!info.address || !info.netmask) continue;
      const range = getScanRange(info.address, info.netmask);
      range.forEach(ip => candidates.add(ip));
    }
  }

  return [...candidates];
}

function isValidInfoResponse(body) {
  if (!body) return false;
  const normalized = body.toLowerCase();
  return normalized.includes('<info') || normalized.includes('deviceid') || normalized.includes('<name>');
}

function parseNameFromInfo(body) {
  if (!body) return null;
  const match = body.match(/<name>([^<]+)<\/name>/i);
  if (match) return match[1].trim();
  return null;
}

function probeSpeaker(ip) {
  return new Promise(resolve => {
    const req = http.request(
      {
        host: ip,
        port: DISCOVERY_PORT,
        path: '/info',
        method: 'GET',
        timeout: DISCOVERY_TIMEOUT,
      },
      res => {
        let body = '';
        res.on('data', chunk => { body += chunk.toString(); });
        res.on('end', () => {
          const valid = res.statusCode === 200 && isValidInfoResponse(body);
          const name = valid ? parseNameFromInfo(body) : null;
          resolve(valid ? { ip, name: name || ip } : null);
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.on('error', () => resolve(null));
    req.end();
  });
}

async function discoverSpeakers() {
  const now = Date.now();
  if (now - lastDiscovery < 30000 && discoveredSpeakers.length > 0) {
    return discoveredSpeakers;
  }

  const candidates = getLocalCandidates();
  const results = [];
  const queue = [...candidates];
  const active = [];

  while (queue.length > 0 || active.length > 0) {
    while (active.length < CONCURRENCY && queue.length > 0) {
      const ip = queue.shift();
      const promise = probeSpeaker(ip).then(result => {
        active.splice(active.indexOf(promise), 1);
        if (result) results.push(result);
      });
      active.push(promise);
    }
    await Promise.race(active);
  }

  discoveredSpeakers = results.sort((a, b) => a.ip.localeCompare(b.ip));
  lastDiscovery = Date.now();
  return discoveredSpeakers;
}

function getSpeakers() {
  return discoveredSpeakers;
}

module.exports = {
  discoverSpeakers,
  getSpeakers,
};
