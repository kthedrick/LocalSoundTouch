const { test } = require('node:test');
const assert = require('node:assert');

const { parseListing } = require('../../ftpClient');

test('Unix listing: folders, audio files, spaces in names', () => {
  const raw = [
    'drwxr-xr-x 2 user group 4096 Jan 01 12:00 Music',
    'drwxr-xr-x 2 user group 4096 Jan 01 12:00 My Music',
    '-rw-r--r-- 1 user group 123456 Jan 01 12:00 song.mp3',
    '-rw-r--r-- 1 user group 123456 Jan 01 12:00 my song.flac',
  ].join('\n');
  assert.deepEqual(parseListing(raw), {
    folders: ['Music', 'My Music'],
    files: ['my song.flac', 'song.mp3'],
  });
});

test('Unix listing: variable whitespace tolerated', () => {
  const { folders } = parseListing('drwxr-xr-x    2 user     group        4096 Jan  1 12:00 Albums');
  assert.deepEqual(folders, ['Albums']);
});

test('DOS listing: <DIR> and file entries', () => {
  const raw = [
    '01-01-24  12:00AM <DIR>          DosFolder',
    '01-01-24  12:00AM          123456 dossong.mp3',
  ].join('\n');
  assert.deepEqual(parseListing(raw), { folders: ['DosFolder'], files: ['dossong.mp3'] });
});

test('dot entries and blank lines skipped', () => {
  const raw = [
    'drwxr-xr-x 2 user group 4096 Jan 01 12:00 .',
    'drwxr-xr-x 2 user group 4096 Jan 01 12:00 ..',
    '',
    '   ',
    'drwxr-xr-x 2 user group 4096 Jan 01 12:00 Real',
  ].join('\n');
  assert.deepEqual(parseListing(raw), { folders: ['Real'], files: [] });
});

test('non-audio files filtered out; folders keep any name', () => {
  const raw = [
    '-rw-r--r-- 1 user group 100 Jan 01 12:00 cover.jpg',
    '-rw-r--r-- 1 user group 100 Jan 01 12:00 notes.txt',
    '-rw-r--r-- 1 user group 100 Jan 01 12:00 track.m4a',
    'drwxr-xr-x 2 user group 4096 Jan 01 12:00 folder.jpg',
  ].join('\n');
  assert.deepEqual(parseListing(raw), { folders: ['folder.jpg'], files: ['track.m4a'] });
});

test('symlinks parsed as non-dirs (audio-filtered like files)', () => {
  assert.deepEqual(parseListing('lrwxrwxrwx 1 user group 11 Jan 01 12:00 link'),
    { folders: [], files: [] });
  assert.deepEqual(parseListing('lrwxrwxrwx 1 user group 11 Jan 01 12:00 link.mp3'),
    { folders: [], files: ['link.mp3'] });
});

test('case-insensitive sort', () => {
  const raw = [
    'drwxr-xr-x 2 user group 4096 Jan 01 12:00 beatles',
    'drwxr-xr-x 2 user group 4096 Jan 01 12:00 Abba',
    'drwxr-xr-x 2 user group 4096 Jan 01 12:00 zappa',
    'drwxr-xr-x 2 user group 4096 Jan 01 12:00 Yes',
  ].join('\n');
  assert.deepEqual(parseListing(raw).folders, ['Abba', 'beatles', 'Yes', 'zappa']);
});
