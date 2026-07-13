const { test } = require('node:test');
const assert = require('node:assert');

const { soapEnvelope, makeDIDL, contentTypeFromUrl } = require('../../upnpHandler');

test('soapEnvelope: action wrapper + XML-escaped args', () => {
  const xml = soapEnvelope('Play', 'urn:schemas-upnp-org:service:AVTransport:1', { InstanceID: '0', Speed: '1&<2>' });
  assert.ok(xml.includes('<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'));
  assert.ok(xml.includes('<InstanceID>0</InstanceID>'));
  assert.ok(xml.includes('<Speed>1&amp;&lt;2&gt;</Speed>'));
  assert.ok(xml.startsWith('<?xml version="1.0"'));
});

test('makeDIDL: escaped title and URL, protocolInfo carries content type', () => {
  const didl = makeDIDL('http://u?a=1&b=2', 'T<i>t', 'audio/flac', null);
  assert.ok(didl.includes('<dc:title>T&lt;i&gt;t</dc:title>'));
  assert.ok(didl.includes('http://u?a=1&amp;b=2'));
  assert.ok(didl.includes('http-get:*:audio/flac:*'));
  assert.ok(!didl.includes('albumArtURI'));
});

test('makeDIDL: art URL adds albumArtURI tag', () => {
  const didl = makeDIDL('http://u', 'T', 'audio/mpeg', 'http://art/cover.jpg');
  assert.ok(didl.includes('albumArtURI'));
  assert.ok(didl.includes('http://art/cover.jpg'));
});

test('contentTypeFromUrl: extension detection survives query strings', () => {
  // regression: cache-buster after encoded path must not hide the extension
  assert.equal(contentTypeFromUrl('http://x/nas/stream?path=%2Fm%2Fsong.flac&_t=123'), 'audio/flac');
  assert.equal(contentTypeFromUrl('http://x/a/song.mp3'), 'audio/mpeg');
  assert.equal(contentTypeFromUrl('http://x/s.wav'), 'audio/wav');
  assert.equal(contentTypeFromUrl('http://x/stream/wcrb'), 'audio/mpeg'); // default
});
