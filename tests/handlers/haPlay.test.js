const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const env = require('../helpers/env');
const { createMockServer } = require('../helpers/mockServices');
const fixtures = require('../helpers/fixtures');
const { Q } = fixtures;

let mock, app;

before(async () => {
  mock = await createMockServer();
  process.env.LST_BOSE_PORT = String(mock.port);
  fixtures.writeHaConfig({ mockPort: mock.port });
  app = await require('../helpers/appServer').startApp();
});

after(async () => { await app.close(); await mock.close(); env.cleanup(); });
beforeEach(() => mock.reset());

const post = (p, body) => fetch(app.base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const maCalls = cmd => mock.requests.filter(r => r.path === '/api' && r.body?.command === cmd).map(r => r.body.args);

test('play: play_media with media (not uri) and string option', async () => {
  const r = await post('/ha/play', { queueId: Q.sunroom, uri: 'library://radio/2' });
  assert.equal((await r.json()).ok, true);
  assert.deepEqual(maCalls('player_queues/play_media'), [
    { queue_id: Q.sunroom, media: 'library://radio/2', option: 'play' },
  ]);
});

test('play: Bedroom redirects to Belkin queue and switches Bose to AUX1', async () => {
  const r = await post('/ha/play', { queueId: Q.bedroom, uri: 'library://radio/1' });
  assert.equal((await r.json()).ok, true);
  assert.deepEqual(maCalls('player_queues/play_media'), [
    { queue_id: Q.belkin, media: 'library://radio/1', option: 'play' },
  ]);
  const sel = mock.requests.find(x => x.path === '/select');
  assert.ok(sel, 'expected Bose /select AUX switch');
  assert.match(sel.body, /source="AUX"/);
});

test('station-uri: retrievable under both original and redirect queue keys', async () => {
  await post('/ha/play', { queueId: Q.bedroom, uri: 'library://radio/5' });
  for (const qid of [Q.bedroom, Q.belkin]) {
    const r = await fetch(app.base + '/ha/station-uri?queueId=' + encodeURIComponent(qid));
    assert.equal((await r.json()).uri, 'library://radio/5');
  }
});
