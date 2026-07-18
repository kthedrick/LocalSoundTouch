// /ha/reset-tv-audio — HDMI/ARC audio reset for the SoundTouch 300.
// Soft: MA release → Bose POWER (unless already standby) → LG tv_speaker →
// Bose /select PRODUCT/TV → LG back to external_arc.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const env = require('../helpers/env');
const { createMockServer } = require('../helpers/mockServices');
const fixtures = require('../helpers/fixtures');
const { Q } = fixtures;

const LG = 'media_player.lg_tv';
let mock, app;

before(async () => {
  mock = await createMockServer();
  process.env.LST_BOSE_PORT = String(mock.port);
  process.env.LST_RESET_STEP_MS = '20';
  fixtures.writeHaConfig({
    mockPort: mock.port,
    overrides: {
      releaseToTV: ['Bose-Sunroom 300'],
      tvConfig: { lgTvEntity: LG, appleTvEntity: 'media_player.appletv', appleTvSource: 'Apple OTT' },
    },
  });
  app = await require('../helpers/appServer').startApp();
});

after(async () => { await app.close(); await mock.close(); env.cleanup(); });
beforeEach(() => mock.reset());

const post = (p, body) => fetch(app.base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const maCalls = cmd => mock.requests.filter(r => r.path === '/api' && r.body?.command === cmd).map(r => r.body.args);
const lgTvOn = (source = 'Apple OTT') =>
  mock.setStates([{ entity_id: LG, state: 'on', attributes: { sound_output: 'external_arc', source } }]);

test('soft reset: MA release, POWER cycle, ARC bounce around TV select, Apple TV wake', async () => {
  lgTvOn();
  const r = await post('/ha/reset-tv-audio', { speakerName: 'Bose-Sunroom 300', ip: '127.0.0.1' });
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.tvOn, true);

  // MA released both the speaker queue and the AirPlay group queue
  assert.deepEqual(maCalls('player_queues/stop').map(a => a.queue_id).sort(), [Q.airplayGroup, Q.sunroom].sort());
  assert.deepEqual(maCalls('player_queues/clear').map(a => a.queue_id).sort(), [Q.airplayGroup, Q.sunroom].sort());

  // POWER press + release fired (speaker was on AIRPLAY)
  const keys = mock.requests.filter(x => x.path === '/key');
  assert.equal(keys.length, 2);
  assert.match(keys[0].body, /press.*POWER/);
  assert.match(keys[1].body, /release.*POWER/);

  // ARC bounce brackets the TV-input select: tv_speaker → /select PRODUCT/TV → external_arc
  const idx = p => mock.requests.findIndex(p);
  const iTvSpeaker = idx(x => x.path === '/api/services/webostv/select_sound_output' && x.body?.sound_output === 'tv_speaker');
  const iSelect    = idx(x => x.path === '/select' && /source="PRODUCT"/.test(x.body) && /sourceAccount="TV"/.test(x.body));
  const iArc       = idx(x => x.path === '/api/services/webostv/select_sound_output' && x.body?.sound_output === 'external_arc');
  assert.ok(iTvSpeaker >= 0 && iSelect >= 0 && iArc >= 0, 'all three steps fired');
  assert.ok(iTvSpeaker < iSelect && iSelect < iArc, 'ARC bounce wraps the TV select');

  // Apple TV was the active input → woken so HDMI signal is present for the handshake
  assert.ok(mock.requests.some(x => x.path === '/api/services/remote/turn_on'), 'Apple TV wake fired');
  assert.deepEqual(d.warnings, [], 'no warnings when every step succeeds');
});

test('soft reset: webostv 500 (TV unreachable) → ok but warning says ARC bounce did not happen', async () => {
  lgTvOn('Live TV');
  mock.failService('/api/services/webostv/');
  const r = await post('/ha/reset-tv-audio', { speakerName: 'Bose-Sunroom 300', ip: '127.0.0.1' });
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.warnings.length, 2, 'both sound-output calls warned');
  assert.match(d.warnings[0], /ARC bounce did NOT happen/);
});

test('soft reset: AirPlay client re-grabs speaker → warning about Apple TV audio output', async () => {
  lgTvOn('Live TV');
  mock.setBoseNowPlaying('<nowPlaying deviceID="X" source="AIRPLAY"><ContentItem source="AIRPLAY"/><playStatus>PLAY_STATE</playStatus></nowPlaying>');
  const r = await post('/ha/reset-tv-audio', { speakerName: 'Bose-Sunroom 300', ip: '127.0.0.1' });
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.ok(d.warnings.some(w => /re-grabbed the speaker/.test(w)), 'expected re-grab warning');
});

test('soft reset: TV off → no webostv calls, still selects TV input', async () => {
  mock.setStates([{ entity_id: LG, state: 'off', attributes: {} }]);
  const r = await post('/ha/reset-tv-audio', { speakerName: 'Bose-Sunroom 300', ip: '127.0.0.1' });
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.tvOn, false);
  assert.ok(!mock.requests.some(x => x.path.startsWith('/api/services/webostv/')), 'no LG calls when TV off');
  assert.ok(mock.requests.some(x => x.path === '/select' && /source="PRODUCT"/.test(x.body)));
});

test('soft reset: speaker already in standby → no POWER key (POWER would wake it early)', async () => {
  lgTvOn('Live TV');  // not the Apple TV source → no wake either
  mock.setBoseNowPlaying('<nowPlaying deviceID="X" source="STANDBY"><ContentItem source="STANDBY"/></nowPlaying>');
  const r = await post('/ha/reset-tv-audio', { speakerName: 'Bose-Sunroom 300', ip: '127.0.0.1' });
  assert.equal((await r.json()).ok, true);
  assert.equal(mock.requests.filter(x => x.path === '/key').length, 0, 'no POWER toggle from standby');
  assert.ok(!mock.requests.some(x => x.path === '/api/services/remote/turn_on'), 'no Apple TV wake for non-Apple source');
});

test('hard reset: console port unreachable → clean error, no crash', async () => {
  // Nothing listens on 127.0.0.1:17000 in tests — expect ok:false
  const r = await post('/ha/reset-tv-audio', { speakerName: 'Bose-Sunroom 300', ip: '127.0.0.1', hard: true });
  const d = await r.json();
  assert.equal(d.ok, false);
  assert.ok(d.error, 'error message present');
});

test('missing ip → error', async () => {
  const r = await post('/ha/reset-tv-audio', { speakerName: 'Bose-Sunroom 300' });
  assert.equal((await r.json()).ok, false);
});
