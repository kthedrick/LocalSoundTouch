const fs   = require('fs');
const path = require('path');

// /data = HA add-on persistent storage — survives image rebuilds (deploy.sh).
// Migrate any legacy __dirname copy on first run so existing results aren't lost.
const DATA_DIR  = fs.existsSync('/data') ? '/data' : __dirname;
const DATA_FILE = path.join(DATA_DIR, 'tests.json');
const LEGACY_FILE = path.join(__dirname, 'tests.json');
if (DATA_DIR !== __dirname && !fs.existsSync(DATA_FILE) && fs.existsSync(LEGACY_FILE)) {
  try { fs.copyFileSync(LEGACY_FILE, DATA_FILE); console.log('[tests] migrated tests.json to /data'); } catch {}
}

function migrateItem(item) {
  if ('checked' in item && !('result' in item)) {
    item.result   = item.checked ? 'pass' : 'none';
    item.resultAt = item.checkedAt || null;
    delete item.checked;
    delete item.checkedAt;
  }
  if (!('note' in item)) item.note = '';
  return item;
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    // migrate: old format was a flat array of test items
    const data = Array.isArray(raw) ? { tests: raw, issues: [] }
                                    : { tests: raw.tests || [], issues: raw.issues || [] };
    data.tests = data.tests.map(migrateItem);
    return data;
  } catch {
    return { tests: [], issues: [] };
  }
}

function save(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
  });
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function ok(res, data)  { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
function fail(res, msg, code = 400) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: msg })); }

module.exports = async function handleTests(req, res) {
  const pathname = req.url.split('?')[0];

  // ── /tests ────────────────────────────────────────────────

  // GET /tests — return both tests and issues
  if (req.method === 'GET' && pathname === '/tests') {
    return ok(res, load());
  }

  // POST /tests — add a test case
  if (req.method === 'POST' && pathname === '/tests') {
    const body = await readBody(req);
    if (!body.description?.trim()) return fail(res, 'description required');
    const data = load();
    data.tests.unshift({
      id: uid(), description: body.description.trim(),
      addedAt: new Date().toISOString(), result: 'none', resultAt: null, note: '',
    });
    save(data);
    return ok(res, { ok: true });
  }

  const testMatch = pathname.match(/^\/tests\/([^/]+)$/);

  // PATCH /tests/:id — update result and/or note independently
  if (req.method === 'PATCH' && testMatch) {
    const body = await readBody(req);
    const data = load();
    const item = data.tests.find(t => t.id === testMatch[1]);
    if (!item) return fail(res, 'not found', 404);
    if ('result' in body) {
      if (!['none', 'pass', 'fail'].includes(body.result)) return fail(res, 'result must be none|pass|fail');
      item.result   = body.result;
      item.resultAt = body.result !== 'none' ? new Date().toISOString() : null;
      if (body.result !== 'fail') item.failSnapshot = null;
    }
    if ('note' in body) item.note = String(body.note).trim();
    if ('failSnapshot' in body) item.failSnapshot = body.failSnapshot;
    save(data);
    return ok(res, { ok: true });
  }

  // DELETE /tests/:id
  if (req.method === 'DELETE' && testMatch) {
    const data = load();
    const idx  = data.tests.findIndex(t => t.id === testMatch[1]);
    if (idx === -1) return fail(res, 'not found', 404);
    data.tests.splice(idx, 1);
    save(data);
    return ok(res, { ok: true });
  }

  // ── /issues ───────────────────────────────────────────────

  // POST /issues — log a new issue
  if (req.method === 'POST' && pathname === '/issues') {
    const body = await readBody(req);
    if (!body.text?.trim()) return fail(res, 'text required');
    const data = load();
    data.issues.unshift({
      id: uid(), text: body.text.trim(),
      loggedAt: new Date().toISOString(),
    });
    save(data);
    return ok(res, { ok: true });
  }

  const issueMatch = pathname.match(/^\/issues\/([^/]+)$/);

  // DELETE /issues/:id
  if (req.method === 'DELETE' && issueMatch) {
    const data = load();
    const idx  = data.issues.findIndex(i => i.id === issueMatch[1]);
    if (idx === -1) return fail(res, 'not found', 404);
    data.issues.splice(idx, 1);
    save(data);
    return ok(res, { ok: true });
  }

  fail(res, 'not found', 404);
};
