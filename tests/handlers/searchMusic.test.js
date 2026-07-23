// /ha/search-music — MA cross-provider search backing the "Search" UI. Verifies the
// artist/track mapping (esp. artistUri from a track, so "play artist" works from a song row).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const env = require('../helpers/env');
const { createMockServer } = require('../helpers/mockServices');
const fixtures = require('../helpers/fixtures');

let mock, app;

before(async () => {
  mock = await createMockServer();
  process.env.LST_BOSE_PORT = String(mock.port);
  fixtures.writeHaConfig({ mockPort: mock.port });
  app = await require('../helpers/appServer').startApp();
});

after(async () => { await app.close(); await mock.close(); env.cleanup(); });
beforeEach(() => { mock.reset(); fixtures.writeHaConfig({ mockPort: mock.port }); });

test('search-music: maps artists and tracks, lifting artistUri/album/image', async () => {
  mock.onMa('music/search', (args) => {
    assert.deepEqual(args.media_types, ['artist', 'track']);
    return {
      artists: [{ name: 'Danny Go!', uri: 'apple_music://artist/1', image: { path: 'http://img/a.jpg' } }],
      tracks: [{
        name: 'All I Eat Is Pizza', uri: 'apple_music://track/9', image: null,
        album: { name: 'Whoopty Whoop' },
        artists: [{ name: 'Koo Koo', uri: 'apple_music://artist/2' }],
      }],
    };
  });
  const d = await (await fetch(app.base + '/ha/search-music?q=pizza')).json();
  assert.equal(d.ok, true);
  assert.equal(d.artists.length, 1);
  assert.equal(d.artists[0].name, 'Danny Go!');
  assert.equal(d.artists[0].image, 'http://img/a.jpg');
  const t = d.tracks[0];
  assert.equal(t.name, 'All I Eat Is Pizza');
  assert.equal(t.artist, 'Koo Koo');
  assert.equal(t.artistUri, 'apple_music://artist/2');
  assert.equal(t.album, 'Whoopty Whoop');
});

test('search-music: empty query short-circuits without hitting MA', async () => {
  let called = false;
  mock.onMa('music/search', () => { called = true; return {}; });
  const d = await (await fetch(app.base + '/ha/search-music?q=%20')).json();
  assert.deepEqual(d.artists, []);
  assert.deepEqual(d.tracks, []);
  assert.equal(called, false);
});
