const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const env = require('../helpers/env');
const { createMockServer } = require('../helpers/mockServices');
const fixtures = require('../helpers/fixtures');

let mock, maClient;

before(async () => {
  mock = await createMockServer();
  fixtures.writeHaConfig({ mockPort: mock.port });
  maClient = require('../../maClient');
});

after(async () => { await mock.close(); env.cleanup(); });
beforeEach(() => mock.reset());

test('maPost sends Bearer token and {command,args} to /api', async () => {
  mock.onMa('player_queues/all', () => [{ queue_id: 'q1' }]);
  const result = await maClient.getAllQueues();
  assert.deepEqual(result, [{ queue_id: 'q1' }]);
  const req = mock.requests.find(r => r.path === '/api');
  assert.deepEqual(req.body, { command: 'player_queues/all', args: {} });
});

test('command wrappers pass correct args', async () => {
  await maClient.stopQueue('q-x');
  await maClient.groupPlayer('member', 'leader');
  await maClient.playMedia('q-y', 'library://radio/2');
  const bodies = mock.requests.map(r => r.body);
  assert.deepEqual(bodies[0], { command: 'player_queues/stop', args: { queue_id: 'q-x' } });
  assert.deepEqual(bodies[1], { command: 'players/cmd/group', args: { player_id: 'member', target_player: 'leader' } });
  assert.deepEqual(bodies[2], { command: 'player_queues/play_media', args: { queue_id: 'q-y', media: 'library://radio/2', option: 'play' } });
});

test('non-JSON response resolves as raw string', async () => {
  // unhandled MA command in mock returns JSON null; use a 404 JSON path instead:
  // point a command at a handler that throws → mock sends text/plain body
  mock.onMa('boom', () => { throw new Error('x'); });
  const result = await maClient.maPost('boom', {});
  assert.equal(result, 'Internal server error');
});

test('missing or placeholder maToken throws', async () => {
  fixtures.writeHaConfig({ mockPort: mock.port, overrides: { maToken: 'YOUR_MA_TOKEN_HERE' } });
  await assert.rejects(() => maClient.maPost('players/all', {}), /maToken not configured/);
  fixtures.writeHaConfig({ mockPort: mock.port }); // restore
});

test('connection refused rejects', async () => {
  // grab a free port then close it so nothing listens there
  const tmp = http.createServer();
  const deadPort = await new Promise(r => tmp.listen(0, '127.0.0.1', () => r(tmp.address().port)));
  await new Promise(r => tmp.close(r));
  fixtures.writeHaConfig({ mockPort: deadPort });
  await assert.rejects(() => maClient.maPost('players/all', {}));
  fixtures.writeHaConfig({ mockPort: mock.port }); // restore
});
