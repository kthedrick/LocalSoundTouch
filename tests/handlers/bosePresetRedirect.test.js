const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const env = require('../helpers/env');
const { createMockServer } = require('../helpers/mockServices');
const fixtures = require('../helpers/fixtures');

let mock, watcher;

before(async () => {
  mock = await createMockServer();
  process.env.LST_BOSE_PORT = String(mock.port);
  fixtures.writeHaConfig({ mockPort: mock.port, overrides: {
    presetActions: { 'Bose-Bedroom': { 5: 'library://radio/1' }, 'Bose-Kitchen': { 5: 'library://radio/1' } },
  } });
  watcher = require('../../boseWatcher');
});

after(async () => { await mock.close(); env.cleanup(); });
beforeEach(() => mock.reset());

const preset = id => `<updates><nowSelectionUpdated><preset id="${id}"><ContentItem source="TUNEIN"/></preset></nowSelectionUpdated></updates>`;
const nowPlaying = src => `<updates><nowPlayingUpdated><nowPlaying source="${src}"/></nowPlayingUpdated></updates>`;
const selects = () => mock.requests.filter(r => r.path === '/select');

// Bedroom preset: the Bose's dead-cloud attempt lands after /ha/play switched it to AUX.
// Must re-select AUX (not leave it off-input, not phantom-stop the Belkin queue).
test('preset on AUX-redirect speaker: late INVALID_SOURCE re-selects AUX1', async () => {
  watcher.handleWsEvent('127.0.0.1', 'Bose-Bedroom', preset(5));
  watcher.handleWsEvent('127.0.0.1', 'Bose-Bedroom', nowPlaying('AUX'));
  watcher.handleWsEvent('127.0.0.1', 'Bose-Bedroom', nowPlaying('INVALID_SOURCE'));
  const sel = await mock.waitFor(r => r.path === '/select');
  assert.match(sel.body, /source="AUX"/);
  assert.match(sel.body, /sourceAccount="AUX1"/);
});

test('preset on AUX-redirect speaker: late non-AUX source does not stop Belkin queue', async () => {
  let stopped = false;
  mock.onMa('player_queues/stop', () => { stopped = true; return null; });
  watcher.handleWsEvent('127.0.0.1', 'Bose-Bedroom', preset(5));
  watcher.handleWsEvent('127.0.0.1', 'Bose-Bedroom', nowPlaying('AUX'));
  watcher.handleWsEvent('127.0.0.1', 'Bose-Bedroom', nowPlaying('TUNEIN'));
  await mock.waitFor(r => r.path === '/select');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(stopped, false);
});

test('no re-select for speakers without a redirect', async () => {
  watcher.handleWsEvent('127.0.0.1', 'Bose-Kitchen', preset(5));
  watcher.handleWsEvent('127.0.0.1', 'Bose-Kitchen', nowPlaying('INVALID_SOURCE'));
  await new Promise(r => setTimeout(r, 200));
  assert.equal(selects().length, 0);
});
