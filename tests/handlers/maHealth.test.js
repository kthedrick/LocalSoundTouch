// /ha/ma-health — MA reachability check backing the UI's "MA down" banner.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const net = require('net');

const env = require('../helpers/env');
const { createMockServer } = require('../helpers/mockServices');
const fixtures = require('../helpers/fixtures');

let mock, app;

before(async () => {
  mock = await createMockServer();
  process.env.LST_BOSE_PORT = String(mock.port);
  fixtures.writeHaConfig({ mockPort: mock.port });
  app = await require('../helpers/appServer').startApp();
});

after(async () => { await app.close(); await mock.close(); env.cleanup(); });
beforeEach(() => { mock.reset(); fixtures.writeHaConfig({ mockPort: mock.port }); });

test('ma-health: MA reachable → maUp true', async () => {
  mock.onMa('players/all', () => []);
  const d = await (await fetch(app.base + '/ha/ma-health')).json();
  assert.equal(d.ok, true);
  assert.equal(d.maUp, true);
});

test('ma-health: MA down → maUp false with actionable error and HA add-on link', async () => {
  // Point maUrl at a port that is definitely closed
  const srv = net.createServer();
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const deadPort = srv.address().port;
  await new Promise(r => srv.close(r));
  fixtures.writeHaConfig({ mockPort: mock.port, overrides: { maUrl: `http://127.0.0.1:${deadPort}` } });

  const d = await (await fetch(app.base + '/ha/ma-health')).json();
  assert.equal(d.maUp, false);
  assert.match(d.error, /Music Assistant unreachable/);
  assert.match(d.maAddonUrl, /\/hassio\/addon\/d5369777_music_assistant\/info$/);
});
