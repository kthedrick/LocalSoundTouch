// One mock HTTP server standing in for MA (:8095 /api), HA (:8123 /api/*) and
// Bose speakers (/select). Records every request for assertions.
const http = require('http');

function createMockServer() {
  const requests   = [];          // { method, path, body }
  const maHandlers = {};          // MA command → fn(args) → response
  let   haStates   = [];          // GET /api/states response
  let   boseNowPlaying = '<nowPlaying source="AIRPLAY"><ContentItem source="AIRPLAY"/></nowPlaying>';
  const failServicePrefixes = [];   // HA service paths that should return 500 (e.g. webostv when TV unreachable)

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = raw; }
      requests.push({ method: req.method, path: req.url, body });

      const send = (code, obj, type = 'application/json') => {
        res.writeHead(code, { 'Content-Type': type });
        res.end(type === 'application/json' ? JSON.stringify(obj) : obj);
      };

      // MA REST API
      if (req.method === 'POST' && req.url === '/api') {
        const fn = maHandlers[body?.command];
        if (fn) {
          try { return send(200, fn(body.args) ?? null); }
          catch (e) { return send(500, 'Internal server error', 'text/plain'); }
        }
        return send(200, null); // MA returns null for fire-and-forget commands
      }
      // HA REST API
      if (req.method === 'GET' && req.url === '/api/states') return send(200, haStates);
      if (req.method === 'GET' && req.url.startsWith('/api/states/')) {
        const entity = decodeURIComponent(req.url.slice('/api/states/'.length));
        const state = haStates.find(s => s.entity_id === entity);
        return state ? send(200, state) : send(404, { message: 'not found' });
      }
      if (req.method === 'POST' && req.url.startsWith('/api/services/')) {
        if (failServicePrefixes.some(p => req.url.startsWith(p))) return send(500, 'Server got itself in trouble', 'text/plain');
        return send(200, []);
      }
      // Bose speaker local API
      if (req.method === 'POST' && req.url === '/select') return send(200, '<status>ok</status>', 'application/xml');
      if (req.method === 'POST' && req.url === '/key')    return send(200, '<status>ok</status>', 'application/xml');
      if (req.method === 'GET'  && req.url === '/now_playing') return send(200, boseNowPlaying, 'application/xml');
      if (req.method === 'GET'  && req.url === '/info')   return send(200, '<info><name>Mock</name></info>', 'application/xml');

      send(404, { error: 'mock: unhandled ' + req.method + ' ' + req.url });
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        requests,
        onMa(command, fn) { maHandlers[command] = fn; },
        setStates(states) { haStates = states; },
        setBoseNowPlaying(xml) { boseNowPlaying = xml; },
        failService(pathPrefix) { failServicePrefixes.push(pathPrefix); },
        reset() {
          requests.length = 0; Object.keys(maHandlers).forEach(k => delete maHandlers[k]); haStates = [];
          boseNowPlaying = '<nowPlaying source="AIRPLAY"><ContentItem source="AIRPLAY"/></nowPlaying>';
          failServicePrefixes.length = 0;
        },
        // Poll until a recorded request matches (for fire-and-forget calls like boseSwitchInput)
        waitFor(pred, ms = 3000) {
          return new Promise((res2, rej) => {
            const t0 = Date.now();
            const iv = setInterval(() => {
              const hit = requests.find(pred);
              if (hit) { clearInterval(iv); res2(hit); }
              else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('waitFor timeout')); }
            }, 25);
          });
        },
        close() { return new Promise(r => server.close(r)); },
      });
    });
  });
}

module.exports = { createMockServer };
