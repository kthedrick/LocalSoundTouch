const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const env = require('../helpers/env');
const fixtures = require('../helpers/fixtures');

let app;

before(async () => {
  fixtures.writeHaConfig({ mockPort: 1 }); // handlers need a parseable config only
  fixtures.writeNasConfig();
  app = await require('../helpers/appServer').startApp();
});

after(async () => { await app.close(); env.cleanup(); });

const api = (p, opts) => fetch(app.base + p, opts);
const json = { 'Content-Type': 'application/json' };

test('tests CRUD lifecycle', async () => {
  // empty shape
  let r = await api('/tests');
  assert.deepEqual(await r.json(), { tests: [], issues: [] });

  // validation
  r = await api('/tests', { method: 'POST', headers: json, body: JSON.stringify({}) });
  assert.equal(r.status, 400);

  // add two — newest first
  await api('/tests', { method: 'POST', headers: json, body: JSON.stringify({ description: 'first' }) });
  await api('/tests', { method: 'POST', headers: json, body: JSON.stringify({ description: '  second  ' }) });
  let data = await (await api('/tests')).json();
  assert.equal(data.tests.length, 2);
  assert.equal(data.tests[0].description, 'second'); // trimmed + unshifted
  assert.equal(data.tests[0].result, 'none');

  const id = data.tests[0].id;

  // PATCH result whitelist
  r = await api(`/tests/${id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ result: 'junk' }) });
  assert.equal(r.status, 400);

  // PATCH result=fail with snapshot, then pass clears snapshot
  await api(`/tests/${id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ result: 'fail', failSnapshot: { x: 1 } }) });
  data = await (await api('/tests')).json();
  assert.equal(data.tests[0].result, 'fail');
  assert.deepEqual(data.tests[0].failSnapshot, { x: 1 });
  assert.ok(data.tests[0].resultAt);

  await api(`/tests/${id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ result: 'pass', note: '  note ' }) });
  data = await (await api('/tests')).json();
  assert.equal(data.tests[0].result, 'pass');
  assert.equal(data.tests[0].failSnapshot, null);
  assert.equal(data.tests[0].note, 'note');

  // result none clears resultAt
  await api(`/tests/${id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ result: 'none' }) });
  data = await (await api('/tests')).json();
  assert.equal(data.tests[0].resultAt, null);

  // DELETE
  r = await api(`/tests/nope`, { method: 'DELETE' });
  assert.equal(r.status, 404);
  r = await api(`/tests/${id}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  data = await (await api('/tests')).json();
  assert.equal(data.tests.length, 1);
});

test('issues add and delete', async () => {
  let r = await api('/issues', { method: 'POST', headers: json, body: JSON.stringify({}) });
  assert.equal(r.status, 400);

  await api('/issues', { method: 'POST', headers: json, body: JSON.stringify({ text: 'squeak' }) });
  const data = await (await api('/tests')).json();
  assert.equal(data.issues.length, 1);
  assert.equal(data.issues[0].text, 'squeak');

  r = await api(`/issues/${data.issues[0].id}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
});

test('legacy flat-array tests.json migrated on read', async () => {
  const file = path.join(env.dataDir, 'tests.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 'a1', description: 'old', checked: true, checkedAt: '2025-01-01T00:00:00Z' }]));
  const data = await (await api('/tests')).json();
  assert.equal(data.tests[0].result, 'pass');
  assert.equal(data.tests[0].resultAt, '2025-01-01T00:00:00Z');
  assert.deepEqual(data.issues, []);
});

test('usage: GET empty, POST increments, validation', async () => {
  let r = await api('/usage');
  assert.deepEqual(await r.json(), {});

  await api('/usage', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Bose-Kitchen' }) });
  await api('/usage', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Bose-Kitchen' }) });
  r = await api('/usage');
  assert.deepEqual(await r.json(), { 'Bose-Kitchen': 2 });

  r = await api('/usage', { method: 'POST', headers: json, body: JSON.stringify({}) });
  assert.equal(r.status, 400);
  r = await api('/usage', { method: 'POST', headers: json, body: 'not json' });
  assert.equal(r.status, 400);
  r = await api('/usage', { method: 'PUT' });
  assert.equal(r.status, 405);
});
