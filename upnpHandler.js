const http  = require('http');
const dgram = require('dgram');

// Cache: ip → { port, controlPath }
const deviceCache = {};

// Use SSDP to discover the UPnP device description URL for a given speaker IP
function ssdpDiscover(ip) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const msearch = [
      'M-SEARCH * HTTP/1.1',
      'HOST: 239.255.255.250:1900',
      'MAN: "ssdp:discover"',
      'MX: 2',
      'ST: ssdp:all',
      '', ''
    ].join('\r\n');

    const timer = setTimeout(() => {
      try { socket.close(); } catch (_) {}
      reject(new Error('SSDP timeout'));
    }, 4000);

    socket.on('message', (msg, rinfo) => {
      if (rinfo.address !== ip) return;
      const text = msg.toString();
      const loc  = text.match(/^LOCATION:\s*(.+)$/im);
      if (loc) {
        clearTimeout(timer);
        try { socket.close(); } catch (_) {}
        resolve(loc[1].trim());
      }
    });

    socket.on('error', (err) => { clearTimeout(timer); reject(err); });

    socket.bind(0, () => {
      const buf = Buffer.from(msearch);
      socket.send(buf, 0, buf.length, 1900, '239.255.255.250', (err) => {
        if (err) { clearTimeout(timer); try { socket.close(); } catch (_) {} reject(err); }
      });
    });
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function httpPost(hostname, port, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path, method: 'POST', headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function probeDevice(ip) {
  if (deviceCache[ip]) return deviceCache[ip];

  // Use SSDP to discover the device description URL dynamically
  let locationUrl = null;
  try {
    locationUrl = await ssdpDiscover(ip);
    console.log(`[UPnP] SSDP found location for ${ip}: ${locationUrl}`);
  } catch (err) {
    console.warn(`[UPnP] SSDP failed for ${ip}:`, err.message);
  }

  // Fall back to common ports if SSDP didn't work
  const urlsToTry = locationUrl
    ? [locationUrl]
    : [8091, 8092, 8093].map(p => `http://${ip}:${p}/DeviceDescription.xml`);

  for (const url of urlsToTry) {
    try {
      const { status, body } = await httpGet(url);
      if (status !== 200) continue;

      const match = body.match(/<serviceType>urn:schemas-upnp-org:service:AVTransport[^<]*<\/serviceType>[\s\S]*?<controlURL>([^<]+)<\/controlURL>/);
      if (!match) continue;

      const parsed = new URL(url);
      const port = parseInt(parsed.port) || 80;
      let controlPath = match[1];
      if (!controlPath.startsWith('/')) controlPath = '/' + controlPath;

      deviceCache[ip] = { port, controlPath };
      console.log(`[UPnP] Found AVTransport on ${ip}:${port}${controlPath}`);
      return deviceCache[ip];
    } catch (_) {}
  }

  console.warn(`[UPnP] No AVTransport found on ${ip}`);
  return null;
}

function soapEnvelope(action, namespace, args) {
  const argsXml = Object.entries(args)
    .map(([k, v]) => `<${k}>${String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</${k}>`)
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${namespace}">
      ${argsXml}
    </u:${action}>
  </s:Body>
</s:Envelope>`;
}

async function soapCall(ip, port, controlPath, action, args) {
  const ns = 'urn:schemas-upnp-org:service:AVTransport:1';
  const body = soapEnvelope(action, ns, args);
  const headers = {
    'Content-Type': 'text/xml; charset="utf-8"',
    'Content-Length': Buffer.byteLength(body),
    'SOAPAction': `"${ns}#${action}"`,
  };
  return httpPost(ip, port, controlPath, body, headers);
}

async function playUrl(ip, url, title) {
  const device = await probeDevice(ip);
  if (!device) throw new Error('UPnP device not found on ' + ip);
  const { port, controlPath } = device;

  await soapCall(ip, port, controlPath, 'SetAVTransportURI', {
    InstanceID: 0,
    CurrentURI: url,
    CurrentURIMetaData: '',
  });
  return soapCall(ip, port, controlPath, 'Play', { InstanceID: 0, Speed: 1 });
}

async function stopPlay(ip) {
  const device = await probeDevice(ip);
  if (!device) throw new Error('UPnP device not found on ' + ip);
  const { port, controlPath } = device;
  return soapCall(ip, port, controlPath, 'Stop', { InstanceID: 0 });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ── SoundTouch LOCAL_INTERNET_RADIO fallback ──────────────────────────────────
// Serves a JSON descriptor that the speaker fetches, then streams the audio URL.
// This is hardware-level and survives Bose cloud deprecation.
let _serverBase = 'http://localhost:3000';
function setServerBase(base) { _serverBase = base; }

const descriptors = {}; // token → { streamUrl, title }

function makeDescriptor(streamUrl, title) {
  const token = Math.random().toString(36).slice(2);
  descriptors[token] = { streamUrl, title };
  return `${_serverBase}/upnp/descriptor/${token}`;
}

async function soundtouchPlay(speakerIp, streamUrl, title) {
  const descriptorUrl = makeDescriptor(streamUrl, title);
  const xml = `<?xml version="1.0" encoding="UTF-8"?><ContentItem source="LOCAL_INTERNET_RADIO" location="${descriptorUrl}"><itemName>${title}</itemName></ContentItem>`;

  return new Promise((resolve, reject) => {
    const body = Buffer.from(xml);
    const req = http.request({
      hostname: speakerIp, port: 8090, path: '/select', method: 'POST',
      headers: { 'Content-Type': 'application/xml', 'Content-Length': body.length },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function handleUpnp(req, res) {
  const urlPath = req.url.split('?')[0];

  // Serve descriptor JSON for LOCAL_INTERNET_RADIO
  if (urlPath.startsWith('/upnp/descriptor/')) {
    const token = urlPath.split('/').pop();
    const desc = descriptors[token];
    if (!desc) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: desc.title,
      imageUrl: '',
      audio: { hasPlaylist: false, isRealtime: false, streamUrl: desc.streamUrl },
      streamType: 'liveRadio',
    }));
    return;
  }

  if (urlPath === '/upnp/play' && req.method === 'POST') {
    const { speakerIp, url, title } = await parseBody(req);
    if (!speakerIp || !url) {
      res.writeHead(400); res.end('speakerIp and url required'); return;
    }
    // Try UPnP first, fall back to SoundTouch API
    try {
      const device = await probeDevice(speakerIp);
      if (device) {
        await playUrl(speakerIp, url, title || '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, method: 'upnp' }));
        return;
      }
    } catch (_) {}

    try {
      await soundtouchPlay(speakerIp, url, title || '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, method: 'soundtouch' }));
    } catch (err) {
      console.error('[play] error:', err.message);
      res.writeHead(500); res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (urlPath === '/upnp/stop' && req.method === 'POST') {
    const { speakerIp } = await parseBody(req);
    if (!speakerIp) {
      res.writeHead(400); res.end('speakerIp required'); return;
    }
    try {
      await stopPlay(speakerIp);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
}

module.exports = { handle: handleUpnp, setServerBase };
