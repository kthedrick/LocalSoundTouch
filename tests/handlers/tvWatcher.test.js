// tvWatcher.switchReason — decides when to auto-switch the soundbar to TV input.
const { test } = require('node:test');
const assert = require('node:assert');
const { switchReason } = require('../../tvWatcher');

test('off → on: switches (any source)', () => {
  assert.equal(switchReason({ on: false, appleWatching: false }, { on: true, appleWatching: false }), 'LG TV turned on');
});

test('on, Apple TV starts playing: switches', () => {
  assert.equal(switchReason({ on: true, appleWatching: false }, { on: true, appleWatching: true }), 'Apple TV playback started');
});

test('on Apple TV but only browsing (not playing): no trigger', () => {
  assert.equal(switchReason({ on: true, appleWatching: false }, { on: true, appleWatching: false }), null);
});

test('first poll (prev null): no trigger', () => {
  assert.equal(switchReason({ on: null, appleWatching: null }, { on: true, appleWatching: true }), null);
});

test('already playing Apple TV (no transition): no re-trigger', () => {
  assert.equal(switchReason({ on: true, appleWatching: true }, { on: true, appleWatching: true }), null);
});

test('TV turns off: no trigger', () => {
  assert.equal(switchReason({ on: true, appleWatching: true }, { on: false, appleWatching: false }), null);
});
