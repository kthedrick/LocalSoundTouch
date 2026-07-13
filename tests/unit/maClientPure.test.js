const { test, after } = require('node:test');
const assert = require('node:assert');

const env      = require('../helpers/env');
const fixtures = require('../helpers/fixtures');

fixtures.writeHaConfig({ mockPort: 1 }); // no server needed — pure config lookups

const { resolveQueueRedirect, getConfig } = require('../../maClient');

after(() => env.cleanup());

test('getConfig reads fixture config from LST_HA_CONFIG', () => {
  assert.equal(getConfig().maToken, 'test-ma-token');
});

test('resolveQueueRedirect: redirected queue maps to target', () => {
  const { queueId, redirect } = resolveQueueRedirect(fixtures.Q.bedroom);
  assert.equal(queueId, fixtures.Q.belkin);
  assert.equal(redirect.speakerName, 'Bose-Bedroom');
});

test('resolveQueueRedirect: non-redirected queue passes through', () => {
  const { queueId, redirect } = resolveQueueRedirect(fixtures.Q.sunroom);
  assert.equal(queueId, fixtures.Q.sunroom);
  assert.equal(redirect, null);
});
