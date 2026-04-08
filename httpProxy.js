const http = require('http');
const fs = require('fs');
const path = require('path');
const speakerDiscovery = require('./speakerDiscovery');
const handleNas = require('./nasHandler');
const upnpModule = require('./upnpHandler');
const handleUpnp = upnpModule.handle;
const handleHa = require('./haHandler');

const publicDir = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.jsx':  'application/javascript',
  '.css':  'text/css',
};

let _baseSet = false;
module.exports = function handleRequest(req, res, serverBase) {
  if (!_baseSet && serverBase) { upnpModule.setServerBase(serverBase); _baseSet = true; }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
        proxyRes.on('end', () => {
          res.writeHead(proxyRes.statusCode, { 'Content-Type': 'text/xml' });
          res.end(data);
        });
      });
      proxyReq.on('error', err => { res.writeHead(500); res.end('Proxy error: ' + err.message); });
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
