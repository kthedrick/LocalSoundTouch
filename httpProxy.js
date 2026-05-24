const http = require('http');
const fs = require('fs');
const path = require('path');
const speakerDiscovery = require('./speakerDiscovery');
const handleNas = require('./nasHandler');
const upnpModule = require('./upnpHandler');
const handleUpnp = upnpModule.handle;
const handleHa   = require('./haHandler');
const handleWiim  = require('./wiimHandler');
const handleTests    = require('./testsHandler');
const handleSnapshot = require('./snapshotHandler');
const handleUsage    = require('./usageHandler');

const publicDir = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.jsx':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
};

let _baseSet = false;
module.exports = function handleRequest(req, res, serverBase) {
  if (!_baseSet && serverBase) { upnpModule.setServerBase(serverBase); _baseSet = true; }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.url === '/serverInfo') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ base: serverBase }));
    return;
  }

  if (req.url === '/speakers') {
    const speakers = speakerDiscovery.getSpeakers();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(speakers));
    return;
  }

  if (req.url.startsWith('/nas/')) {
    handleNas(req, res, serverBase);
    return;
  }

  if (req.url.startsWith('/upnp/')) {
    handleUpnp(req, res);
    return;
  }

  if (req.url.startsWith('/ha/')) {
    handleHa(req, res);
    return;
  }

  // GET /wcrb.json — LOCAL_INTERNET_RADIO descriptor for Bose speakers
  if (req.url === '/wcrb.json') {
    const serverBase = req.headers.host ? `http://${req.headers.host}` : 'http://192.168.1.124:3000';
    console.log('[wcrb.json] fetched by', req.socket.remoteAddress);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ audio: { hasPlaylist: false, isRealtime: true, streamUrl: serverBase + '/stream/wcrb' }, imageUrl: '', name: '99.5 WCRB', streamType: 'liveRadio' }));
    return;
  }

  // GET /stream/wcrb — proxy WCRB audio stream as plain HTTP for Bose LOCAL_INTERNET_RADIO
  if (req.url === '/stream/wcrb') {
    const https = require('https');
    console.log('[stream/wcrb] connected from', req.socket.remoteAddress);
    const upReq = https.request({
      hostname: 'wgbh-live.streamguys1.com',
      path: '/classical-hi',
      method: 'GET',
      headers: { 'User-Agent': 'SoundTouch/1.0', 'Icy-MetaData': '0' },
    }, (uRes) => {
      const headers = { 'Content-Type': uRes.headers['content-type'] || 'audio/mpeg' };
      for (const [k, v] of Object.entries(uRes.headers)) {
        if (k.startsWith('icy-') || k === 'cache-control' || k === 'pragma') headers[k] = v;
      }
      res.writeHead(200, headers);
      uRes.pipe(res);
      res.on('error', () => uRes.destroy());
      uRes.on('error', () => { if (!res.writableEnded) res.end(); });
      req.on('close', () => uRes.destroy());
    });
    upReq.on('error', (e) => { console.error('[stream/wcrb]', e.message); if (!res.headersSent) { res.writeHead(502); res.end(); } });
    upReq.end();
    return;
  }

  if (req.url.startsWith('/wiim/')) {
    handleWiim(req, res);
    return;
  }

  if (req.url === '/tests' || req.url.startsWith('/tests/') ||
      req.url === '/issues' || req.url.startsWith('/issues/')) {
    handleTests(req, res);
    return;
  }

  if (req.url === '/usage') {
    handleUsage(req, res);
    return;
  }

  if (req.url === '/snapshot') {
    handleSnapshot(req, res);
    return;
  }

  if (req.url.startsWith('/api/')) {
    const parts = req.url.split('/');
    const ip = parts[2];
    const endpoint = '/' + parts.slice(3).join('/');
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      const options = {
        hostname: ip, port: 8090, path: endpoint, method: req.method,
        headers: body ? { 'Content-Type': 'application/xml' } : {}
      };
      const proxyReq = http.request(options, (proxyRes) => {
        let data = '';
        proxyRes.on('data', chunk => { data += chunk; });
        proxyRes.on('error', err => { if (!res.headersSent) { res.writeHead(500); res.end('Proxy error: ' + err.message); } });
        proxyRes.on('end', () => {
          if (!res.headersSent) res.writeHead(proxyRes.statusCode, { 'Content-Type': 'text/xml' });
          if (!res.writableEnded) res.end(data);
        });
      });
      proxyReq.on('error', err => { if (!res.headersSent) { res.writeHead(500); res.end('Proxy error: ' + err.message); } });
      if (body) proxyReq.write(body);
      proxyReq.end();
    });
    return;
  }

  // Static file serving from public/
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.join(publicDir, urlPath);

  if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
};
