const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');

const env = require('../helpers/env');
const fixtures = require('../helpers/fixtures');
const ftp = require('../../ftpClient'); // nasHandler calls through this object — mockable

let app;

before(async () => {
  fixtures.writeHaConfig({ mockPort: 1 });
  fixtures.writeNasConfig({ host: '10.9.9.9', username: 'nasuser', password: 'naspass' });
  app = await require('../helpers/appServer').startApp();
});

after(async () => { await app.close(); env.cleanup(); });
beforeEach(() => mock.restoreAll());

function fakeCtrl() { return { end() {}, destroy() {} }; }

test('browse returns folders/files and prioritizes WMP Large art', async () => {
  mock.method(ftp, 'list', async (host, user, pass, p) => {
    assert.equal(host, '10.9.9.9');
    assert.equal(user, 'nasuser');
    assert.equal(pass, 'naspass');
    assert.equal(p, '/music/Muse');
    return { folders: ['Disc 1'], files: ['a.mp3'] };
  });
  mock.method(ftp, 'listAll', async () => [
    'folder.jpg', 'AlbumArt_{123-ABC}_Large.jpg', 'AlbumArt_{123-ABC}_Small.jpg', 'a.mp3',
  ]);
  const r = await fetch(app.base + '/nas/browse?path=' + encodeURIComponent('/music/Muse'));
  const body = await r.json();
  assert.deepEqual(body, {
    path: '/music/Muse',
    artFile: 'AlbumArt_{123-ABC}_Large.jpg',
    folders: ['Disc 1'],
    files: ['a.mp3'],
  });
});

test('browse art fallbacks: exact names, then WMP Small, then null', async () => {
  mock.method(ftp, 'list', async () => ({ folders: [], files: [] }));

  mock.method(ftp, 'listAll', async () => ['cover.jpg', 'AlbumArt_{1}_Small.jpg']);
  let body = await (await fetch(app.base + '/nas/browse?path=/x')).json();
  assert.equal(body.artFile, 'cover.jpg');

  mock.method(ftp, 'listAll', async () => ['AlbumArt_{1}_Small.jpg', 'z.mp3']);
  body = await (await fetch(app.base + '/nas/browse?path=/x')).json();
  assert.equal(body.artFile, 'AlbumArt_{1}_Small.jpg');

  mock.method(ftp, 'listAll', async () => { throw new Error('ftp down'); });
  body = await (await fetch(app.base + '/nas/browse?path=/x')).json();
  assert.equal(body.artFile, null); // art errors are swallowed, browse still works
});

test('browse: ftp.list failure → 500 with error', async () => {
  mock.method(ftp, 'list', async () => { throw new Error('530 Login incorrect'); });
  mock.method(ftp, 'listAll', async () => []);
  const r = await fetch(app.base + '/nas/browse?path=/x');
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /530/);
});

test('stream without Range: 200, full length, body bytes intact', async () => {
  const audio = Buffer.from('FAKE-FLAC-DATA-1234567890');
  mock.method(ftp, 'getFileSize', async () => audio.length);
  mock.method(ftp, 'retrieve', async (h, u, p, fp, startByte) => {
    assert.equal(startByte, 0);
    const s = new PassThrough();
    s.end(audio);
    return { dataSocket: s, ctrl: fakeCtrl() };
  });
  const r = await fetch(app.base + '/nas/stream?path=' + encodeURIComponent('/m/song.flac'));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/flac');
  assert.equal(r.headers.get('content-length'), String(audio.length));
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(Buffer.from(await r.arrayBuffer()).toString(), audio.toString());
});

test('stream with Range: 206 + Content-Range + retrieve offset', async () => {
  const size = 10000;
  mock.method(ftp, 'getFileSize', async () => size);
  let gotStart = null;
  mock.method(ftp, 'retrieve', async (h, u, p, fp, startByte) => {
    gotStart = startByte;
    const s = new PassThrough();
    s.end(Buffer.alloc(size - startByte));
    return { dataSocket: s, ctrl: fakeCtrl() };
  });
  const r = await fetch(app.base + '/nas/stream?path=/m/s.mp3', { headers: { Range: 'bytes=1000-' } });
  assert.equal(r.status, 206);
  assert.equal(gotStart, 1000);
  assert.equal(r.headers.get('content-range'), `bytes 1000-${size - 1}/${size}`);
  assert.equal(r.headers.get('content-length'), String(size - 1000));
});

test('stream: missing path → 400; ftp error → 500', async () => {
  let r = await fetch(app.base + '/nas/stream');
  assert.equal(r.status, 400);

  mock.method(ftp, 'getFileSize', async () => { throw new Error('no such file'); });
  r = await fetch(app.base + '/nas/stream?path=/m/gone.mp3');
  assert.equal(r.status, 500);
});

test('m3u: EXTM3U with serverBase-prefixed encoded stream URLs', async () => {
  mock.method(ftp, 'list', async () => ({ folders: [], files: ['01 One.mp3', '02 Two.flac'] }));
  const r = await fetch(app.base + '/nas/m3u?path=' + encodeURIComponent('/music/Album'));
  const text = await r.text();
  const lines = text.split('\n');
  assert.equal(lines[0], '#EXTM3U');
  assert.equal(lines[1], '#EXTINF:0,01 One');
  assert.equal(lines[2], `${app.base}/nas/stream?path=${encodeURIComponent('/music/Album/01 One.mp3')}`);
  assert.equal(lines[3], '#EXTINF:0,02 Two');
});

test('unknown /nas route → 404', async () => {
  const r = await fetch(app.base + '/nas/bogus');
  assert.equal(r.status, 404);
});
