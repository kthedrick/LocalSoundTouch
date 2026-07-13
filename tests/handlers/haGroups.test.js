const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const env = require('../helpers/env');
const { createMockServer } = require('../helpers/mockServices');
const fixtures = require('../helpers/fixtures');
const { Q, E, maPlayer, haState } = fixtures;

let mock, app, getActiveGroups;

before(async () => {
  mock = await createMockServer();
  process.env.LST_BOSE_PORT = String(mock.port); // before haHandler loads
  fixtures.writeHaConfig({ mockPort: mock.port });
  getActiveGroups = require('../../haHandler').getActiveGroups;
  app = await require('../helpers/appServer').startApp();
});

after(async () => { await app.close(); await mock.close(); env.cleanup(); });
beforeEach(() => mock.reset());

const post = (p, body) => fetch(app.base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const maCalls = cmd => mock.requests.filter(r => r.path === '/api' && r.body?.command === cmd).map(r => r.body.args);

// ── /ha/group-include ──────────────────────────────────────────────────────

test('group-include: playing leader gets cmd/group per member', async () => {
  mock.onMa('players/all', () => [
    maPlayer(Q.sunroom, { state: 'playing' }),
    maPlayer(Q.kitchen), maPlayer(Q.living),
  ]);
  const r = await post('/ha/group-include', { masterName: 'Bose-Sunroom 300', speakerNames: ['Bose-Kitchen', 'Bose-Living Room'] });
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.deepEqual(maCalls('players/cmd/group'), [
    { player_id: Q.kitchen, target_player: Q.sunroom },
    { player_id: Q.living,  target_player: Q.sunroom },
  ]);
});

// Regression: a paused player earlier in MA's list must NOT hijack leadership
// while the configured leader is itself playing (the Sunroom false-correction bug).
test('group-include: playing leader is trusted despite earlier non-idle player', async () => {
  mock.onMa('players/all', () => [
    maPlayer(Q.sunroom, { state: 'paused' }),   // earlier in list, not idle
    maPlayer(Q.living,  { state: 'playing' }),  // configured leader — playing
    maPlayer(Q.kitchen),
  ]);
  await post('/ha/group-include', { masterName: 'Bose-Living Room', speakerNames: ['Bose-Kitchen'] });
  assert.deepEqual(maCalls('players/cmd/group'), [{ player_id: Q.kitchen, target_player: Q.living }]);
});

test('group-include: idle configured leader corrected to the actually-playing player', async () => {
  mock.onMa('players/all', () => [
    maPlayer(Q.sunroom, { state: 'playing', synced_to: null }),
    maPlayer(Q.living,  { state: 'idle' }),
    maPlayer(Q.kitchen),
  ]);
  await post('/ha/group-include', { masterName: 'Bose-Living Room', speakerNames: ['Bose-Kitchen'] });
  assert.deepEqual(maCalls('players/cmd/group'), [{ player_id: Q.kitchen, target_player: Q.sunroom }]);
});

// Regression: players/all returns a plain ARRAY — code must not expect {players:[...]}
test('group-include: works with the real array response shape', async () => {
  mock.onMa('players/all', () => [maPlayer(Q.sunroom, { state: 'playing' }), maPlayer(Q.wiim)]);
  const r = await post('/ha/group-include', { masterName: 'Bose-Sunroom 300', speakerNames: ['WiiM Basement'] });
  assert.equal((await r.json()).ok, true);
  assert.deepEqual(maCalls('players/cmd/group'), [{ player_id: Q.wiim, target_player: Q.sunroom }]);
});

test('group-include: Bedroom redirect groups the Belkin queue and switches AUX', async () => {
  mock.onMa('players/all', () => [maPlayer(Q.sunroom, { state: 'playing' })]);
  await post('/ha/group-include', { masterName: 'Bose-Sunroom 300', speakerNames: ['Bose-Bedroom'] });
  assert.deepEqual(maCalls('players/cmd/group'), [{ player_id: Q.belkin, target_player: Q.sunroom }]);
  // boseSwitchInput fires async against the redirect IP (127.0.0.1:mock)
  const sel = await mock.waitFor(r => r.path === '/select');
  assert.match(sel.body, /source="AUX"/);
  assert.match(sel.body, /sourceAccount="AUX1"/);
});

test('group-include: validation and unknown names', async () => {
  let r = await post('/ha/group-include', { speakerNames: ['Bose-Kitchen'] });
  assert.equal(r.status, 500); // masterName required

  r = await post('/ha/group-include', { masterName: 'Bose-Sunroom 300' });
  assert.equal(r.status, 500); // speakerNames required

  mock.onMa('players/all', () => [maPlayer(Q.sunroom, { state: 'playing' }), maPlayer(Q.kitchen)]);
  r = await post('/ha/group-include', { masterName: 'Bose-Sunroom 300', speakerNames: ['Nonexistent', 'Bose-Kitchen'] });
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.results.length, 1); // unknown skipped, known grouped
  assert.deepEqual(maCalls('players/cmd/group'), [{ player_id: Q.kitchen, target_player: Q.sunroom }]);

  // Unknown master WITH a playing player: leader correction adopts the playing player
  r = await post('/ha/group-include', { masterName: 'Nonexistent', speakerNames: ['Bose-Kitchen'] });
  assert.equal((await r.json()).ok, true);
  const calls = maCalls('players/cmd/group');
  assert.deepEqual(calls[calls.length - 1], { player_id: Q.kitchen, target_player: Q.sunroom });

  // Unknown master with NO playing player: error
  mock.reset();
  r = await post('/ha/group-include', { masterName: 'Nonexistent', speakerNames: ['Bose-Kitchen'] });
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /No MA player ID for leader/);
});

test('group-include: bass side effect fires when Sunroom+Living Room group', async () => {
  mock.onMa('players/all', () => [
    maPlayer(Q.sunroom, { state: 'playing' }),
    maPlayer(Q.living,  { synced_to: Q.sunroom }),
  ]);
  mock.setStates([haState(E.sunroom, [E.living])]);
  await post('/ha/group-include', { masterName: 'Bose-Sunroom 300', speakerNames: ['Bose-Living Room'] });
  // applyGroupSideEffects runs on a 1.5s timer after the response
  const sw = await mock.waitFor(r => r.path.startsWith('/api/services/switch/'), 4000);
  assert.equal(sw.path, '/api/services/switch/turn_on');
  assert.equal(sw.body.entity_id, 'switch.living_room_bass');
});

// ── /ha/group-remove ───────────────────────────────────────────────────────

test('group-remove: ungroups the speaker queue', async () => {
  const r = await post('/ha/group-remove', { speakerName: 'Bose-Kitchen' });
  assert.equal((await r.json()).ok, true);
  assert.deepEqual(maCalls('players/cmd/ungroup'), [{ player_id: Q.kitchen }]);
});

test('group-remove: redirect speaker ungroups the Belkin queue', async () => {
  await post('/ha/group-remove', { speakerName: 'Bose-Bedroom' });
  assert.deepEqual(maCalls('players/cmd/ungroup'), [{ player_id: Q.belkin }]);
});

// Regression: ungroup must be sent unconditionally — no can_group_with gating.
// (MA reports can_group_with: [] while a player is synced; the old heuristic
// misrouted removal to a broken WebSocket path.)
test('group-remove: sent even when player reports can_group_with []', async () => {
  mock.onMa('players/all', () => [maPlayer(Q.wiim, { synced_to: Q.sunroom, can_group_with: [] })]);
  const r = await post('/ha/group-remove', { speakerName: 'WiiM Basement' });
  assert.equal((await r.json()).ok, true);
  assert.deepEqual(maCalls('players/cmd/ungroup'), [{ player_id: Q.wiim }]);
});

test('group-remove: unknown speaker → error', async () => {
  const r = await post('/ha/group-remove', { speakerName: 'Nonexistent' });
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /No MA player ID/);
});

// ── getActiveGroups / /ha/group-state ──────────────────────────────────────

test('group-state shape 1: leader lists only members', async () => {
  mock.setStates([haState(E.joshua, [E.rosemary])]);
  mock.onMa('players/all', () => []);
  assert.deepEqual(await getActiveGroups(), [{ leader: 'Bose-Joshua', members: ['Bose-Rosemary'] }]);
});

test('group-state shape 2: leader includes itself in group_members', async () => {
  mock.setStates([haState(E.sunroom, [E.sunroom, E.kitchen])]);
  mock.onMa('players/all', () => []);
  assert.deepEqual(await getActiveGroups(), [{ leader: 'Bose-Sunroom 300', members: ['Bose-Kitchen'] }]);
});

test('group-state shape 3: member listing only itself produces no group', async () => {
  mock.setStates([haState(E.rosemary, [E.rosemary])]);
  mock.onMa('players/all', () => []);
  assert.deepEqual(await getActiveGroups(), []);
});

test('group-state: duplicate descriptions deduped by member set', async () => {
  mock.setStates([
    haState(E.joshua, [E.rosemary]),
    haState(E.rosemary, [E.rosemary, E.joshua]), // same pair, different phrasing
  ]);
  mock.onMa('players/all', () => []);
  const groups = await getActiveGroups();
  assert.equal(groups.length, 1);
});

test('group-state: strict-subset stale group dropped', async () => {
  mock.setStates([
    haState(E.sunroom, [E.living, E.kitchen]),
    haState(E.living, [E.sunroom]), // stale subset {living,sunroom}
  ]);
  mock.onMa('players/all', () => []);
  const groups = await getActiveGroups();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].leader, 'Bose-Sunroom 300');
  assert.deepEqual(groups[0].members.sort(), ['Bose-Kitchen', 'Bose-Living Room']);
});

test('group-state: MA synced_to synthesizes group when HA has none', async () => {
  mock.setStates([]);
  mock.onMa('players/all', () => [
    maPlayer(Q.sunroom, { state: 'playing' }),
    maPlayer(Q.wiim, { synced_to: Q.sunroom }),
  ]);
  assert.deepEqual(await getActiveGroups(), [{ leader: 'Bose-Sunroom 300', members: ['WiiM Basement'] }]);
});

test('group-state: leader promoted to the synced_to:null playing player', async () => {
  mock.setStates([haState(E.living, [E.sunroom])]); // HA thinks Living leads
  mock.onMa('players/all', () => [
    maPlayer(Q.sunroom, { state: 'playing', synced_to: null }),
    maPlayer(Q.living,  { state: 'playing', synced_to: Q.sunroom }),
  ]);
  const groups = await getActiveGroups();
  assert.equal(groups[0].leader, 'Bose-Sunroom 300');
  assert.deepEqual(groups[0].members, ['Bose-Living Room']);
});

test('group-state: idle synced_to:null player is NOT promoted', async () => {
  mock.setStates([haState(E.living, [E.sunroom])]);
  mock.onMa('players/all', () => [
    maPlayer(Q.sunroom, { state: 'idle', synced_to: null }),
    maPlayer(Q.living,  { state: 'idle', synced_to: null }),
  ]);
  const groups = await getActiveGroups();
  assert.equal(groups[0].leader, 'Bose-Living Room'); // unchanged
});

test('group-state: Belkin queue maps back to Bose-Bedroom', async () => {
  mock.setStates([]);
  mock.onMa('players/all', () => [
    maPlayer(Q.sunroom, { state: 'playing' }),
    maPlayer(Q.belkin, { synced_to: Q.sunroom }),
  ]);
  assert.deepEqual(await getActiveGroups(), [{ leader: 'Bose-Sunroom 300', members: ['Bose-Bedroom'] }]);
});

test('GET /ha/group-state endpoint wraps getActiveGroups', async () => {
  mock.setStates([haState(E.joshua, [E.rosemary])]);
  mock.onMa('players/all', () => []);
  const r = await fetch(app.base + '/ha/group-state');
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.groups, [{ leader: 'Bose-Joshua', members: ['Bose-Rosemary'] }]);
});
