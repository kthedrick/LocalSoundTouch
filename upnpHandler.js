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

function makeDIDL(url, title, contentType, artUrl) {
  const escaped = url.replace(/&/g, '&amp;');
  const safeTitle = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const artTag = artUrl ? `<upnp:albumArtURI>${artUrl.replace(/&/g, '&amp;')}</upnp:albumArtURI>` : '';
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="1" parentID="0" restricted="1"><dc:title>${safeTitle}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class>${artTag}<res protocolInfo="http-get:*:${contentType}:*">${escaped}</res></item></DIDL-Lite>`;
}

const MIME_FOR_EXT = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.wma': 'audio/x-ms-wma', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.alac': 'audio/mp4',
};

function contentTypeFromUrl(url) {
  const m = url.match(/\.([a-z0-9]+)(?:\?|$)/i);
  return m ? (MIME_FOR_EXT['.' + m[1].toLowerCase()] || 'audio/mpeg') : 'audio/mpeg';
}

async function playUrl(ip, url, title, artUrl) {
  const device = await probeDevice(ip);
  if (!device) throw new Error('UPnP device not found on ' + ip);
  const { port, controlPath } = device;

  const contentType = contentTypeFromUrl(url);
  const metadata = makeDIDL(url, title, contentType, artUrl);

  await soapCall(ip, port, controlPath, 'SetAVTransportURI', {
    InstanceID: 0,
    CurrentURI: url,
    CurrentURIMetaData: metadata,
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

// ── Queue management ──────────────────────────────────────────────────────────
const queues = {}; // speakerIp → { tracks, idx, timerId, repeatMode }

async function getTransportState(ip) {
  try {
    const device = await probeDevice(ip);
    if (!device) return null;
    const { port, controlPath } = device;
    const result = await soapCall(ip, port, controlPath, 'GetTransportInfo', { InstanceID: 0 });
    const m = result.body.match(/<CurrentTransportState>([^<]+)<\/CurrentTransportState>/);
    return m ? m[1] : null;
  } catch (_) { return null; }
}

async function playQueueNext(speakerIp) {
  const q = queues[speakerIp];
  if (!q) return;

  console.log(`[Queue] playQueueNext ${speakerIp} repeatMode=${q.repeatMode} idx=${q.idx} total=${q.tracks.length}`);

  // Repeat one: rewind so we replay the track that just finished
  if (q.repeatMode === 'REPEAT_ONE' && q.idx > 0) {
    q.idx--;
    console.log(`[Queue] REPEAT_ONE rewind → idx=${q.idx}`);
  }

  // End of queue
  if (q.idx >= q.tracks.length) {
    if (q.repeatMode === 'REPEAT_ALL') {
      q.idx = 0;
      console.log(`[Queue] REPEAT_ALL wrap → idx=0`);
    } else {
      console.log(`[Queue] end of queue, stopping`);
      delete queues[speakerIp];
      return;
    }
  }

  const track = q.tracks[q.idx++];
  console.log(`[Queue] ${speakerIp} playing track ${q.idx}/${q.tracks.length}: ${track.title}`);
  try {
    // Add cache-buster so the speaker treats each play as a fresh stream (prevents
    // it from sending a Range header starting at EOF when replaying the same URL)
    const sep = track.url.includes('?') ? '&' : '?';
    const freshUrl = track.url + sep + '_t=' + Date.now();
    // Stop first to ensure the speaker's transport is in a clean state
    try { await stopPlay(speakerIp); } catch (_) {}
    await playUrl(speakerIp, freshUrl, track.title, track.artUrl);
    console.log(`[Queue] playUrl succeeded, starting poll`);

    // Two-phase poll:
    //   Phase 1 — wait until we confirm PLAYING (up to 15s), so we don't
    //             mistake the brief STOPPED/TRANSITIONING state right after
    //             SetAVTransportURI for "track finished".
    //   Phase 2 — once playing, watch for STOPPED and advance queue.
    let seenPlaying = false;
    let phase1Ticks = 0;
    const pollInterval = setInterval(async () => {
      if (!queues[speakerIp] || queues[speakerIp] !== q) { clearInterval(pollInterval); return; }
      const state = await getTransportState(speakerIp);
      console.log(`[Queue] poll ${speakerIp} state=${state} seenPlaying=${seenPlaying} phase1Ticks=${phase1Ticks}`);

      if (!seenPlaying) {
        if (state === 'PLAYING') { seenPlaying = true; return; }
        // Give up waiting for PLAYING after 15s — something went wrong
        if (++phase1Ticks >= 5) {
          console.log(`[Queue] phase1 timeout waiting for PLAYING, giving up`);
          clearInterval(pollInterval);
          delete queues[speakerIp];
        }
        return;
      }

      if (state === 'STOPPED' || state === 'NO_MEDIA_PRESENT') {
        console.log(`[Queue] track ended (${state}), advancing`);
        clearInterval(pollInterval);
        playQueueNext(speakerIp);
      }
    }, 3000);
    q.timerId = pollInterval;
  } catch (err) {
    console.error('[Queue] playUrl error:', err.message);
    delete queues[speakerIp];
  }
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
    const { speakerIp, url, title, artUrl } = await parseBody(req);
    if (!speakerIp || !url) {
      res.writeHead(400); res.end('speakerIp and url required'); return;
    }
    // Try UPnP first — route through queue so repeat/polling work for single tracks too
    try {
      const device = await probeDevice(speakerIp);
      if (device) {
        const prevRepeat = queues[speakerIp]?.repeatMode || 'REPEAT_OFF';
        if (queues[speakerIp]?.timerId) clearInterval(queues[speakerIp].timerId);
        queues[speakerIp] = { tracks: [{ url, title: title || '', artUrl }], idx: 0, timerId: null, repeatMode: prevRepeat };
        await playQueueNext(speakerIp);
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

  if (urlPath === '/upnp/queue/skip' && req.method === 'POST') {
    const { speakerIp } = await parseBody(req);
    if (!speakerIp) { res.writeHead(400); res.end('speakerIp required'); return; }
    const q = queues[speakerIp];
    if (!q) { res.writeHead(200); res.end(JSON.stringify({ ok: true, msg: 'no queue' })); return; }
    if (q.timerId) clearInterval(q.timerId);
    try { await stopPlay(speakerIp); } catch (_) {}
    await playQueueNext(speakerIp);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (urlPath === '/upnp/queue/prev' && req.method === 'POST') {
    const { speakerIp } = await parseBody(req);
    if (!speakerIp) { res.writeHead(400); res.end('speakerIp required'); return; }
    const q = queues[speakerIp];
    if (!q) { res.writeHead(200); res.end(JSON.stringify({ ok: true, msg: 'no queue' })); return; }
    if (q.timerId) clearInterval(q.timerId);
    q.idx = Math.max(0, q.idx - 2); // -1 for current (already incremented), -1 more to go back
    try { await stopPlay(speakerIp); } catch (_) {}
    await playQueueNext(speakerIp);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (urlPath === '/upnp/queue' && req.method === 'POST') {
    const { speakerIp, tracks } = await parseBody(req);
    if (!speakerIp || !Array.isArray(tracks) || !tracks.length) {
      res.writeHead(400); res.end('speakerIp and tracks[] required'); return;
    }
    if (queues[speakerIp]?.timerId) clearInterval(queues[speakerIp].timerId);
    const prevRepeat = queues[speakerIp]?.repeatMode || 'REPEAT_OFF';
    queues[speakerIp] = { tracks, idx: 0, timerId: null, repeatMode: prevRepeat };
    try {
      await playQueueNext(speakerIp);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, total: tracks.length }));
    } catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (urlPath === '/upnp/stop' && req.method === 'POST') {
    const { speakerIp } = await parseBody(req);
    if (!speakerIp) {
      res.writeHead(400); res.end('speakerIp required'); return;
    }
    if (queues[speakerIp]?.timerId) clearInterval(queues[speakerIp].timerId);
    delete queues[speakerIp];
    try {
      await stopPlay(speakerIp);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (urlPath === '/upnp/queue/state' && req.method === 'GET') {
    const ip = new URL(req.url, 'http://localhost').searchParams.get('speakerIp');
    const q = ip && queues[ip];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ repeatMode: q?.repeatMode || 'REPEAT_OFF' }));
    return;
  }

  if (urlPath === '/upnp/queue/repeat' && req.method === 'POST') {
    const { speakerIp, repeatMode } = await parseBody(req);
    if (!speakerIp) { res.writeHead(400); res.end('speakerIp required'); return; }
    if (queues[speakerIp]) queues[speakerIp].repeatMode = repeatMode;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, repeatMode }));
    return;
  }

  res.writeHead(404); res.end('Not found');
}

module.exports = { handle: handleUpnp, setServerBase };
