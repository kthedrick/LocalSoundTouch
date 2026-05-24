const fs   = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'usage.json');

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return {}; }
}

module.exports = function handleUsage(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET') {
    res.end(JSON.stringify(load()));
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { name } = JSON.parse(body);
        if (!name) { res.writeHead(400); res.end(JSON.stringify({ error: 'name required' })); return; }
        const data = load();
        data[name] = (data[name] || 0) + 1;
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'bad json' }));
      }
    });
    return;
  }

  res.writeHead(405);
  res.end(JSON.stringify({ error: 'method not allowed' }));
};
