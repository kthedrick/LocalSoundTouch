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
