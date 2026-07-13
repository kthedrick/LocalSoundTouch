const { test } = require('node:test');
const assert = require('node:assert');

// migrateItem is pure — safe to require testsHandler (its require-time /data
// migration is a no-op here because env.js is not loaded and DATA_DIR=__dirname).
const { migrateItem } = require('../../testsHandler');

test('legacy checked:true → result pass with resultAt from checkedAt', () => {
  const item = migrateItem({ id: '1', checked: true, checkedAt: '2026-01-01T00:00:00Z' });
  assert.equal(item.result, 'pass');
  assert.equal(item.resultAt, '2026-01-01T00:00:00Z');
  assert.ok(!('checked' in item));
  assert.ok(!('checkedAt' in item));
});

test('legacy checked:false → result none, null resultAt', () => {
  const item = migrateItem({ id: '1', checked: false });
  assert.equal(item.result, 'none');
  assert.equal(item.resultAt, null);
});

test('already-migrated items untouched, note default added', () => {
  const item = migrateItem({ id: '1', result: 'fail', resultAt: 'x' });
  assert.equal(item.result, 'fail');
  assert.equal(item.note, '');
});

test('existing note preserved', () => {
  assert.equal(migrateItem({ id: '1', result: 'pass', note: 'keep' }).note, 'keep');
});
