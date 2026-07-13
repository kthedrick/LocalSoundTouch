const { test } = require('node:test');
const assert = require('node:assert');

const { artistMatches, extractPerformer } = require('../../hybridOrchestrator');

test('artistMatches: substring in either direction', () => {
  assert.ok(artistMatches('radiohead', 'radiohead', ''));
  assert.ok(artistMatches('the smashing pumpkins', 'smashing pumpkins', ''));
  assert.ok(artistMatches('muse', 'muse feat. someone', ''));
});

test('artistMatches: word fallback catches composer first-name variants', () => {
  // Pandora "Fryderyk Chopin" vs Apple Music "Frédéric Chopin" — matches via "chopin"
  assert.ok(artistMatches('frédéric chopin', 'fryderyk chopin', ''));
  // multi-word diacritic variants also match via the unaccented word
  assert.ok(artistMatches('antonin dvořák', 'antonin dvorak', ''));
});

// Pins the diacritic gap documented in CLAUDE.md (single-word names only).
// Update this test when NFD normalization is added to artistMatches.
test('artistMatches: single-word diacritic variant does NOT match (known gap)', () => {
  assert.ok(!artistMatches('dvořák', 'dvorak', ''));
});

test('artistMatches: words of ≤3 chars excluded from fallback', () => {
  assert.ok(!artistMatches('the who', 'los who', ''));
});

test('artistMatches: empty normalized artist always matches', () => {
  assert.ok(artistMatches('anyone', '', ''));
  assert.ok(artistMatches('anyone', null, ''));
});

test('artistMatches: album-name (aName) participates in word fallback', () => {
  assert.ok(artistMatches('various artists', 'yo-yo ma', 'yo-yo ma plays bach'));
});

test('extractPerformer: "Performer, Composer: Work" format', () => {
  assert.equal(extractPerformer('Vladimir Ashkenazy, Chopin: Ballades'), 'Vladimir Ashkenazy');
});

test('extractPerformer: rejects non-classical shapes', () => {
  assert.equal(extractPerformer('OK Computer'), null);              // no comma
  assert.equal(extractPerformer('Yo-Yo Ma, Bach Cello Suites'), null); // no colon after comma
  assert.equal(extractPerformer('Argerich, Chopin: Preludes'), null);  // single-word performer
  assert.equal(extractPerformer(null), null);
  assert.equal(extractPerformer(''), null);
});
