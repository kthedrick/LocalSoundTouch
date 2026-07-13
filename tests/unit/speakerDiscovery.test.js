const { test } = require('node:test');
const assert = require('node:assert');

const { ipToInt, intToIp, maskToPrefix, getScanRange, isValidInfoResponse, parseNameFromInfo } = require('../../speakerDiscovery');

test('ipToInt/intToIp round-trip', () => {
  for (const ip of ['192.168.1.124', '10.0.0.1', '0.0.0.0', '255.255.255.255']) {
    assert.equal(intToIp(ipToInt(ip)), ip);
  }
  assert.equal(ipToInt('192.168.1.0'), 0xC0A80100);
});

test('maskToPrefix common masks', () => {
  assert.equal(maskToPrefix('255.255.255.0'), 24);
  assert.equal(maskToPrefix('255.255.255.128'), 25);
  assert.equal(maskToPrefix('255.255.0.0'), 16);
  assert.equal(maskToPrefix('255.255.255.255'), 32);
});

test('getScanRange /24 scans 254 hosts excluding network and broadcast', () => {
  const range = getScanRange('192.168.1.124', '255.255.255.0');
  assert.equal(range.length, 254);
  assert.equal(range[0], '192.168.1.1');
  assert.equal(range[253], '192.168.1.254');
  assert.ok(!range.includes('192.168.1.0'));
  assert.ok(!range.includes('192.168.1.255'));
});

test('getScanRange /31 and /32 return empty', () => {
  assert.deepEqual(getScanRange('10.0.0.1', '255.255.255.254'), []);
  assert.deepEqual(getScanRange('10.0.0.1', '255.255.255.255'), []);
});

test('getScanRange /25 scans 126 hosts within subnet half', () => {
  const range = getScanRange('192.168.1.200', '255.255.255.128');
  assert.equal(range.length, 126);
  assert.equal(range[0], '192.168.1.129');
  assert.equal(range[125], '192.168.1.254');
});

// Pins current behavior: wide masks are capped to a /24-style 254-host scan
test('getScanRange /16 still scans only 254 hosts (current cap)', () => {
  const range = getScanRange('10.1.2.3', '255.255.0.0');
  assert.equal(range.length, 254);
  assert.equal(range[0], '10.1.2.1');
});

test('isValidInfoResponse accepts Bose /info shapes, rejects junk', () => {
  assert.ok(isValidInfoResponse('<info deviceID="x">...</info>'));
  assert.ok(isValidInfoResponse('...deviceid...'));
  assert.ok(isValidInfoResponse('<name>Bose-Kitchen</name>'));
  assert.ok(!isValidInfoResponse(''));
  assert.ok(!isValidInfoResponse(null));
  assert.ok(!isValidInfoResponse('<html>router login</html>'));
});

test('parseNameFromInfo extracts and trims name', () => {
  assert.equal(parseNameFromInfo('<info><name>  Bose-Patio </name></info>'), 'Bose-Patio');
  assert.equal(parseNameFromInfo('<NAME>Bose-Office</NAME>'), 'Bose-Office');
  assert.equal(parseNameFromInfo('<info></info>'), null);
  assert.equal(parseNameFromInfo(null), null);
});
