// /ha/switch-state + /ha/switch-set — manual speaker toggles (Living Room bass).
// Allowlisted to entities in cfg.speakerToggles; groupSideEffects still flip the
// same switch automatically.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const env = require('../helpers/env');
const { createMockServer } = require('../helpers/mockServices');
const fixtures = require('../helpers/fixtures');

const BASS = 'switch.living_room_bass';
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

test('switch-state: returns HA state for an allowlisted toggle', async () => {
  mock.setStates([{ entity_id: BASS, state: 'on', attributes: {} }]);
  const d = await (await fetch(app.base + '/ha/switch-state?entity=' + BASS)).json();
  assert.equal(d.ok, true);
  assert.equal(d.state, 'on');
});

test('switch-state: unknown entity rejected', async () => {
  const d = await (await fetch(app.base + '/ha/switch-state?entity=switch.evil')).json();
  assert.equal(d.ok, false);
});

test('switch-set: on/off call the right HA services', async () => {
  let d = await (await post('/ha/switch-set', { entity: BASS, on: true })).json();
  assert.equal(d.state, 'on');
  d = await (await post('/ha/switch-set', { entity: BASS, on: false })).json();
  assert.equal(d.state, 'off');
  const svc = mock.requests.filter(x => x.path.startsWith('/api/services/switch/'));
  assert.deepEqual(svc.map(x => x.path), ['/api/services/switch/turn_on', '/api/services/switch/turn_off']);
  assert.ok(svc.every(x => x.body.entity_id === BASS));
});

test('switch-set: unknown entity rejected, no service call', async () => {
  const d = await (await post('/ha/switch-set', { entity: 'switch.evil', on: true })).json();
  assert.equal(d.ok, false);
  assert.equal(mock.requests.filter(x => x.path.startsWith('/api/services/switch/')).length, 0);
});

test('switch-set: HA 500 surfaced as error', async () => {
  mock.failService('/api/services/switch/');
  const d = await (await post('/ha/switch-set', { entity: BASS, on: true })).json();
  assert.equal(d.ok, false);
  assert.match(d.error, /500/);
});
