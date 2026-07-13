const { test } = require('node:test');
const assert = require('node:assert');

const { xmlField, xmlAttr, hexDecode, wiimMode } = require('../../snapshotHandler');

const NOW_PLAYING = `<nowPlaying deviceID="ABCDEF" source="AIRPLAY" sourceAccount="AirPlay2DefaultUserName">
  <ContentItem source="AIRPLAY" isPresetable="false" />
  <track>Darkshines</track>
  <artist>Muse</artist>
  <album>Origin of Symmetry</album>
  <playStatus>PLAY_STATE</playStatus>
</nowPlaying>`;

test('xmlField extracts tag text', () => {
  assert.equal(xmlField(NOW_PLAYING, 'track'), 'Darkshines');
  assert.equal(xmlField(NOW_PLAYING, 'artist'), 'Muse');
  assert.equal(xmlField(NOW_PLAYING, 'playStatus'), 'PLAY_STATE');
  assert.equal(xmlField(NOW_PLAYING, 'missing'), null);
});

test('xmlAttr extracts attribute value', () => {
  assert.equal(xmlAttr(NOW_PLAYING, 'nowPlaying', 'source'), 'AIRPLAY');
  assert.equal(xmlAttr(NOW_PLAYING, 'nowPlaying', 'deviceID'), 'ABCDEF');
  assert.equal(xmlAttr(NOW_PLAYING, 'nowPlaying', 'nope'), null);
});

test('hexDecode: hex→utf8, passthrough for non-hex', () => {
  assert.equal(hexDecode('4D757365'), 'Muse');
  assert.equal(hexDecode('none'), 'none');   // non-hex passthrough
  assert.equal(hexDecode('xyz'), 'xyz');
  assert.equal(hexDecode(''), null);
});

test('wiimMode: LinkPlay mode → source label', () => {
  assert.equal(wiimMode('1'), 'AIRPLAY');
  assert.equal(wiimMode('2'), 'DLNA');
  assert.equal(wiimMode('31'), 'SPOTIFY');
  assert.equal(wiimMode('40'), 'AUX');
  assert.equal(wiimMode('0'), null);
  assert.equal(wiimMode('99'), null);
});
