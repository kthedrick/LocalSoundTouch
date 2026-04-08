// HTTP handler for /ha/* routes — Music Assistant integration

const { stopQueue, clearQueue, pauseQueue, resumeQueue, nextTrack, prevTrack, getAllQueues, playMedia, getConfig } = require('./maClient');

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { resolve({}); }
    });
  });
}

function ok(res, data)  { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, ...data })); }
function err(res, msg)  { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: msg })); }

async function handleHa(req, res) {
  const url = req.url;

  // GET /ha/config — return haConfig (no token) for the UI
  if (url === '/ha/config' && req.method === 'GET') {
    const cfg = getConfig();
    const safe = { queues: cfg.queues || {}, speakerQueues: cfg.speakerQueues || {}, favorites: cfg.favorites || [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(safe));
    return;
  }

  // GET /ha/queues — list all MA queues (for discovery)
  if (url === '/ha/queues' && req.method === 'GET') {
    try {
      const result = await getAllQueues();
      ok(res, { queues: result });
    } catch (e) { err(res, e.message); }
    return;
  }

  // POST /ha/clear — clear a queue (stop + remove all items so MA won't restart) { queueId }
  if (url === '/ha/clear' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const result = await clearQueue(body.queueId);
      console.log('[ha/clear] queueId=%s result=%j', body.queueId, result);
      ok(res, { result });
    } catch (e) {
      console.error('[ha/clear] error:', e.message);
      err(res, e.message);
    }
    return;
  }

  // POST /ha/stop — stop a queue { queueId }
  if (url === '/ha/stop' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      await stopQueue(body.queueId);
      ok(res, {});
    } catch (e) { err(res, e.message); }
    return;
  }

  // POST /ha/pause — pause a queue { queueId }
  if (url === '/ha/pause' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      await pauseQueue(body.queueId);
      ok(res, {});
    } catch (e) { err(res, e.message); }
    return;
  }

  // POST /ha/resume — resume a queue { queueId }
  if (url === '/ha/resume' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      await resumeQueue(body.queueId);
      ok(res, {});
    } catch (e) { err(res, e.message); }
    return;
  }

  // POST /ha/next — next track { queueId }
  if (url === '/ha/next' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      await nextTrack(body.queueId);
      ok(res, {});
    } catch (e) { err(res, e.message); }
    return;
  }

  // POST /ha/prev — previous track { queueId }
  if (url === '/ha/prev' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      await prevTrack(body.queueId);
      ok(res, {});
    } catch (e) { err(res, e.message); }
    return;
  }

  // POST /ha/play — play a favorite { queueId, uri }
  if (url === '/ha/play' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const result = await playMedia(body.queueId, body.uri);
      ok(res, { result });
    } catch (e) { err(res, e.message); }
    return;
  }

  // GET /ha/schema — fetch MA's API schema for debugging
  if (url === '/ha/schema' && req.method === 'GET') {
    const { maPost: _, getConfig, ...rest } = require('./maClient');
    const cfg = getConfig();
    const maUrl = new URL(cfg.maUrl || 'http://localhost:8095');
    const http = require('http');
    const proxyReq = http.request({
      hostname: maUrl.hostname,
      port: parseInt(maUrl.port) || 8095,
      path: '/openapi.json',
      method: 'GET',
    }, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    });
    proxyReq.on('error', e => { res.writeHead(500); res.end(e.message); });
    proxyReq.end();
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

module.exports = handleHa;
