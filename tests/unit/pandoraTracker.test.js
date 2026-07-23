// pandoraTracker resilience — tracks collected while Apple Music is down must be persisted
// (not dropped) and backfilled once AM recovers. Also covers the parenthetical-suffix search
// fallback. Pure unit test: point LST_DATA_DIR at a temp dir and pass a stub maPost.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

// DATA_DIR is resolved at module load, so set it BEFORE requiring the tracker.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lst-tracker-'));
process.env.LST_DATA_DIR = DATA_DIR;
const tracker = require('../../pandoraTracker');
const DATA_FILE = path.join(DATA_DIR, 'pandoraPlaylists.json');

const readData = () => JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const findTrack = (station, title) =>
  (readData()[station]?.tracks || []).find(t => t.title === title);

// Stub maPost. `alwaysFail`: Apple Music returns no tracks (provider down). `failParens`:
// queries containing "(" return nothing, so only the cleaned-query fallback matches.
function makeMaPost({ alwaysFail = false, failParens = false } = {}) {
  return async (command, args) => {
    if (command === 'music/search') {
      if ((args.media_types || []).includes('playlist')) return { playlists: [] };  // no MA playlist
      const q = args.search_query || '';
      if (alwaysFail) return { tracks: [] };
      if (failParens && q.includes('(')) return { tracks: [] };
      // album present → skips the hybridOrchestrator album fallback (which would hit the network)
      return { tracks: [{
        uri: 'apple_music://track/' + q.replace(/\W+/g, ''),
        album: { name: 'Mock Album' },
        provider_mappings: [{ provider_domain: 'apple_music' }],
      }] };
    }
    return {};
  };
}

beforeEach(() => fs.writeFileSync(DATA_FILE, '{}'));
after(() => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {} });

test('addToPlaylist persists an unresolved entry when Apple Music has no match', async () => {
  await tracker.addToPlaylist(makeMaPost({ alwaysFail: true }), 'Test Radio', 'Some Artist', 'Some Title', '');
  const t = findTrack('Test Radio', 'Some Title');
  assert.ok(t, 'track was persisted despite no Apple Music match');
  assert.equal(t.appleUri, null);
  assert.equal(t.needsResolve, true);
});

test('resolveUnresolved fills in appleUri once Apple Music recovers', async () => {
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    'Test Radio': { maPlaylistId: null, tracks: [
      { artist: 'Some Artist', title: 'Some Title', album: '', appleUri: null, needsResolve: true, addedAt: 'x' },
    ] },
  }));
  const r = await tracker.resolveUnresolved(makeMaPost());
  assert.equal(r.resolved, 1);
  assert.equal(r.stillMissing, 0);
  const t = findTrack('Test Radio', 'Some Title');
  assert.ok(t.appleUri && t.appleUri.startsWith('apple_music://'));
  assert.ok(!t.needsResolve);
});

test('cleaned-query fallback resolves titles with parenthetical suffixes', async () => {
  await tracker.addToPlaylist(makeMaPost({ failParens: true }),
    'Test Radio', 'Herbie Hancock', 'Cantaloupe Island (Remastered 1999/Rudy Van Gelder Edition)', '');
  const t = findTrack('Test Radio', 'Cantaloupe Island (Remastered 1999/Rudy Van Gelder Edition)');
  assert.ok(t, 'track persisted');
  assert.ok(t.appleUri && t.appleUri.startsWith('apple_music://'), 'resolved via cleaned query, not left unresolved');
  assert.ok(!t.needsResolve);
});

test('addToPlaylist dedups an already-resolved track (no duplicate row)', async () => {
  const maPost = makeMaPost();
  await tracker.addToPlaylist(maPost, 'Test Radio', 'Dup Artist', 'Dup Title', '');
  await tracker.addToPlaylist(maPost, 'Test Radio', 'Dup Artist', 'Dup Title', '');
  const rows = readData()['Test Radio'].tracks.filter(t => t.title === 'Dup Title');
  assert.equal(rows.length, 1);
});

test('resolveUnresolved leaves a track unresolved when Apple Music still has no match', async () => {
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    'Test Radio': { maPlaylistId: null, tracks: [
      { artist: 'Obscure', title: 'Nowhere Track', album: '', appleUri: null, needsResolve: true, addedAt: 'x' },
    ] },
  }));
  const r = await tracker.resolveUnresolved(makeMaPost({ alwaysFail: true }));
  assert.equal(r.resolved, 0);
  assert.equal(r.stillMissing, 1);
  assert.equal(findTrack('Test Radio', 'Nowhere Track').appleUri, null);
});
