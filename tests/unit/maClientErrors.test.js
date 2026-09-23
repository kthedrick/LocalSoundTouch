// maPost connection failures must be actionable — the 2026-07-18 MA-add-on-stopped
// outage surfaced only as blank "poll error:" lines (AggregateError has empty .message).
const { test, after } = require('node:test');
const assert = require('node:assert');
const net = require('net');

const env = require('../helpers/env');
const fixtures = require('../helpers/fixtures');

after(() => env.cleanup());

test('maPost: connection refused → "check Music Assistant" error, never blank', async () => {
  // Grab a port that is definitely closed: bind, note it, release it
  const srv = net.createServer();
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise(r => srv.close(r));

  fixtures.writeHaConfig({ mockPort: port });
  const { maPost } = require('../../maClient');
  await assert.rejects(
    () => maPost('players/all', {}),
    (e) => {
      assert.match(e.message, /Music Assistant unreachable/);
      assert.match(e.message, /check that the Music Assistant add-on is running/);
      assert.match(e.message, /players\/all/);  // names the failing command
      assert.ok(e.message.length > 40, 'message is never blank');
      return true;
    },
  );
});

test('maPost: timeout → "slow to respond", not "unreachable"', async () => {
  // Accepts the connection but never replies
  const sockets = [];
  const srv = net.createServer(s => sockets.push(s));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  fixtures.writeHaConfig({ mockPort: srv.address().port });
  process.env.LST_MA_TIMEOUT_MS = '200';
  const { maPost } = require('../../maClient');
  try {
    await assert.rejects(
      () => maPost('player_queues/play_media', {}),
      (e) => {
        assert.match(e.message, /slow to respond/);
        assert.match(e.message, /may still start/);
        assert.doesNotMatch(e.message, /unreachable/);
        assert.equal(e.code, 'MA_TIMEOUT');
        return true;
      },
    );
  } finally {
    delete process.env.LST_MA_TIMEOUT_MS;
    sockets.forEach(s => s.destroy());
    await new Promise(r => srv.close(r));
  }
});

test('play_media gets a longer timeout than other MA commands', () => {
  const { SLOW_COMMANDS } = require('../../maClient');
  assert.ok(SLOW_COMMANDS['player_queues/play_media'] >= 20000);
});
