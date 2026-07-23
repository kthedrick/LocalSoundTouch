// recentSearches — server-side "recently played" list backing the Search UI's recents.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lst-recent-'));
process.env.LST_DATA_DIR = DIR;               // must be set before require
const recent = require('../../recentSearches');
const FILE = path.join(DIR, 'recentSearches.json');

beforeEach(() => { try { fs.unlinkSync(FILE); } catch {} });
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

test('add: newest first, dedup by uri (replaying moves to top, no dupe)', () => {
  recent.add({ type: 'track', name: 'A', uri: 'u:1' });
  recent.add({ type: 'track', name: 'B', uri: 'u:2' });
  recent.add({ type: 'track', name: 'A again', uri: 'u:1' });
  const list = recent.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].uri, 'u:1');
  assert.equal(list[0].name, 'A again');
  assert.equal(list[1].uri, 'u:2');
});

test('add: caps the list at 40', () => {
  for (let i = 0; i < 50; i++) recent.add({ type: 'track', name: 'T' + i, uri: 'u:' + i });
  const list = recent.list(100);
  assert.equal(list.length, 40);
  assert.equal(list[0].uri, 'u:49');   // newest kept
});

test('add: ignores an entry with no uri', () => {
  recent.add({ type: 'track', name: 'no uri' });
  assert.equal(recent.list().length, 0);
});

test('add: normalizes type and preserves artistUri', () => {
  recent.add({ type: 'weird', name: 'X', uri: 'u:x' });
  recent.add({ type: 'artist', name: 'Danny Go!', uri: 'u:a', artistUri: 'u:a' });
  const [artist, track] = recent.list();
  assert.equal(artist.type, 'artist');
  assert.equal(artist.artistUri, 'u:a');
  assert.equal(track.type, 'track');   // unknown type coerced to 'track'
});

test('list: survives a missing/corrupt file', () => {
  fs.writeFileSync(FILE, 'not json');
  assert.deepEqual(recent.list(), []);
});
