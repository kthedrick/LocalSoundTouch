const { test } = require('node:test');
const assert = require('node:assert');

const { hexDecode, modeToSource } = require('../../wiimHandler');

test('hexDecode: hex→utf8 with XML entity decoding', () => {
  assert.equal(hexDecode('4D757365'), 'Muse');
  assert.equal(hexDecode('49262333393B6D'), "I'm"); // &#39; entity decoded
});

test('modeToSource: LinkPlay mode table', () => {
  assert.equal(modeToSource('1'), 'AIRPLAY');
  assert.equal(modeToSource('2'), 'DLNA');
  assert.equal(modeToSource('11'), 'WIIM');  // USB disk
  assert.equal(modeToSource('31'), 'SPOTIFY');
  assert.equal(modeToSource('36'), 'WIIM');
  assert.equal(modeToSource('40'), 'AUX');
  assert.equal(modeToSource('0'), null);     // idle
  assert.equal(modeToSource('99'), null);    // unknown
});
