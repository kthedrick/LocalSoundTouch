const { test } = require('node:test');
const assert = require('node:assert');

const { parseFrames } = require('../../boseWatcher');

// Build a WebSocket frame: FIN + opcode, optional mask, payload
function frame(payload, { opcode = 0x1, masked = false, ext16 = false } = {}) {
  const data = Buffer.from(payload);
  const parts = [];
  const b0 = 0x80 | opcode;
  if (ext16 || data.length > 125) {
    parts.push(Buffer.from([b0, (masked ? 0x80 : 0) | 126]));
    const len = Buffer.alloc(2); len.writeUInt16BE(data.length); parts.push(len);
  } else {
    parts.push(Buffer.from([b0, (masked ? 0x80 : 0) | data.length]));
  }
  if (masked) {
    const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
    parts.push(mask);
    parts.push(Buffer.from(data.map((b, i) => b ^ mask[i % 4])));
  } else {
    parts.push(data);
  }
  return Buffer.concat(parts);
}

test('single unmasked text frame', () => {
  const { frames, remaining } = parseFrames(frame('<updates/>'));
  assert.deepEqual(frames, ['<updates/>']);
  assert.equal(remaining.length, 0);
});

test('masked frame unmasks payload', () => {
  const { frames } = parseFrames(frame('hello', { masked: true }));
  assert.deepEqual(frames, ['hello']);
});

test('16-bit extended length (>125 bytes)', () => {
  const big = 'x'.repeat(300);
  const { frames } = parseFrames(frame(big, { ext16: true }));
  assert.deepEqual(frames, [big]);
});

test('partial frame deferred, returned as remaining', () => {
  const full = frame('deferred-payload');
  const cut  = full.slice(0, full.length - 5);
  const { frames, remaining } = parseFrames(cut);
  assert.deepEqual(frames, []);
  assert.equal(remaining.length, cut.length); // untouched, waiting for more bytes
});

test('multiple frames in one buffer', () => {
  const buf = Buffer.concat([frame('one'), frame('two'), frame('three')]);
  const { frames } = parseFrames(buf);
  assert.deepEqual(frames, ['one', 'two', 'three']);
});

test('non-text opcodes consumed but not returned', () => {
  const ping = frame('ping', { opcode: 0x9 });
  const buf  = Buffer.concat([ping, frame('text')]);
  const { frames, remaining } = parseFrames(buf);
  assert.deepEqual(frames, ['text']);
  assert.equal(remaining.length, 0);
});

test('continuation opcode (0x0) treated as text', () => {
  const { frames } = parseFrames(frame('cont', { opcode: 0x0 }));
  assert.deepEqual(frames, ['cont']);
});
