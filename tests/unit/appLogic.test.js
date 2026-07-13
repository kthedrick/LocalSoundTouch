const { test } = require('node:test');
const assert = require('node:assert');

const { formatTime, buildRedirectMap, computeGroups } = require('../../public/js/appLogic');

// ── formatTime ─────────────────────────────────────────────────────────────

test('formatTime', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(65), '1:05');
  assert.equal(formatTime(3725), '62:05');
  assert.equal(formatTime(-5), '0:00');
  assert.equal(formatTime(59.9), '0:59');
});

// ── buildRedirectMap ───────────────────────────────────────────────────────

test('buildRedirectMap keys by fromQueue, keeps full entry', () => {
  const map = buildRedirectMap([{ speakerName: 'Bose-Bedroom', fromQueue: 'q-bed', toQueue: 'q-belkin' }]);
  assert.equal(map['q-bed'].toQueue, 'q-belkin');
  assert.equal(map['q-x'], undefined);
  assert.deepEqual(buildRedirectMap(null), {});
});

// ── computeGroups ──────────────────────────────────────────────────────────

const SPEAKERS = [
  { name: 'Sunroom', ip: '10.0.0.1', brand: 'bose' },
  { name: 'Living',  ip: '10.0.0.2', brand: 'bose' },
  { name: 'Kitchen', ip: '10.0.0.3', brand: 'bose' },
  { name: 'WiiM',    ip: '10.0.0.4', brand: 'wiim' },
];

function spk(name, ip, { playStatus = 'STOP_STATE', nowPlaying = null, zoneInfo = null } = {}) {
  return { name, ip, playStatus, nowPlaying, zoneInfo };
}

function airplay(track, artist, position) {
  return { source: 'AIRPLAY', track, artist, position };
}

function run({ speakerData, maGroups = [], sessionOrder = null, removingMembers = new Set() }) {
  return computeGroups({ speakerData, speakers: SPEAKERS, defaultSpeakers: SPEAKERS, maGroups, sessionOrder, removingMembers });
}

test('empty speakerData → no groups', () => {
  assert.deepEqual(run({ speakerData: {} }), []);
});

test('standalone speakers get one card each', () => {
  const speakerData = {
    '10.0.0.1': spk('Sunroom', '10.0.0.1'),
    '10.0.0.3': spk('Kitchen', '10.0.0.3'),
  };
  const groups = run({ speakerData });
  assert.equal(groups.length, 2);
  assert.ok(groups.every(g => g.speakers.length === 1));
});

test('Bose zone: master listed first, members absorbed', () => {
  const zone = { masterIp: '10.0.0.1', memberIps: ['10.0.0.2'] };
  const speakerData = {
    '10.0.0.1': spk('Sunroom', '10.0.0.1', { zoneInfo: zone }),
    '10.0.0.2': spk('Living', '10.0.0.2', { zoneInfo: zone }),
    '10.0.0.3': spk('Kitchen', '10.0.0.3'),
  };
  const groups = run({ speakerData });
  assert.equal(groups.length, 2);
  const zoneCard = groups.find(g => g.masterIp === '10.0.0.1');
  assert.equal(zoneCard.speakers.length, 2);
  assert.equal(zoneCard.speakers[0].name, 'Sunroom'); // master first
});

test('MA group merge: member card hidden, appended to leader, maMembers tracked', () => {
  const speakerData = {
    '10.0.0.1': spk('Sunroom', '10.0.0.1', { playStatus: 'PLAY_STATE' }),
    '10.0.0.4': spk('WiiM', '10.0.0.4', { playStatus: 'PLAY_STATE' }),
  };
  const groups = run({ speakerData, maGroups: [{ leader: 'Sunroom', members: ['WiiM'] }] });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].speakers.map(s => s.name), ['Sunroom', 'WiiM']);
  assert.deepEqual(groups[0].maMembers, ['WiiM']);
  assert.ok(!groups[0].phantomGroup);
});

test('phantom group: two PLAY_STATE AirPlay speakers, same track, close positions', () => {
  const speakerData = {
    '10.0.0.1': spk('Sunroom', '10.0.0.1', { playStatus: 'PLAY_STATE', nowPlaying: airplay('Darkshines', 'Muse', 100) }),
    '10.0.0.4': spk('WiiM', '10.0.0.4', { playStatus: 'PLAY_STATE', nowPlaying: airplay('Darkshines', 'Muse', 105) }),
  };
  const groups = run({ speakerData });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].phantomGroup, true);
  assert.deepEqual(groups[0].phantomMembers, ['WiiM']);
  assert.equal(groups[0].speakers.length, 2);
});

// Regression: stopped speaker with stale identical metadata must NOT be absorbed
// (WiiM keeps last-track metadata after stop — the "ghost group" bug)
test('phantom group: STOP_STATE speaker with stale matching metadata not absorbed', () => {
  const speakerData = {
    '10.0.0.1': spk('Sunroom', '10.0.0.1', { playStatus: 'PLAY_STATE', nowPlaying: airplay('Darkshines', 'Muse', 100) }),
    '10.0.0.4': spk('WiiM', '10.0.0.4', { playStatus: 'STOP_STATE', nowPlaying: airplay('Darkshines', 'Muse', 279) }),
  };
  const groups = run({ speakerData });
  assert.equal(groups.length, 2);
  assert.ok(groups.every(g => !g.phantomGroup));
});

test('phantom group: positions >15s apart not merged', () => {
  const speakerData = {
    '10.0.0.1': spk('Sunroom', '10.0.0.1', { playStatus: 'PLAY_STATE', nowPlaying: airplay('T', 'A', 10) }),
    '10.0.0.4': spk('WiiM', '10.0.0.4', { playStatus: 'PLAY_STATE', nowPlaying: airplay('T', 'A', 60) }),
  };
  assert.equal(run({ speakerData }).length, 2);
});

test('phantom group: all-zero positions still merge (position unknown)', () => {
  const speakerData = {
    '10.0.0.1': spk('Sunroom', '10.0.0.1', { playStatus: 'PLAY_STATE', nowPlaying: airplay('T', 'A', 0) }),
    '10.0.0.4': spk('WiiM', '10.0.0.4', { playStatus: 'PLAY_STATE', nowPlaying: airplay('T', 'A', 0) }),
  };
  const groups = run({ speakerData });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].phantomGroup, true);
});

test('phantom group: speaker mid-removal excluded from phantom detection', () => {
  const speakerData = {
    '10.0.0.1': spk('Sunroom', '10.0.0.1', { playStatus: 'PLAY_STATE', nowPlaying: airplay('T', 'A', 100) }),
    '10.0.0.4': spk('WiiM', '10.0.0.4', { playStatus: 'PLAY_STATE', nowPlaying: airplay('T', 'A', 100) }),
  };
  const groups = run({ speakerData, removingMembers: new Set(['WiiM']) });
  assert.equal(groups.length, 2);
});

test('phantom group: different sources or missing metadata not bucketed', () => {
  const speakerData = {
    '10.0.0.1': spk('Sunroom', '10.0.0.1', { playStatus: 'PLAY_STATE', nowPlaying: { source: 'UPNP', track: 'T', artist: 'A', position: 5 } }),
    '10.0.0.4': spk('WiiM', '10.0.0.4', { playStatus: 'PLAY_STATE', nowPlaying: airplay('T', 'A', 5) }),
  };
  assert.equal(run({ speakerData }).length, 2);
});

test('sessionOrder ranks cards; unknown IPs sink to the bottom', () => {
  const speakerData = {
    '10.0.0.1': spk('Sunroom', '10.0.0.1'),
    '10.0.0.2': spk('Living', '10.0.0.2'),
    '10.0.0.3': spk('Kitchen', '10.0.0.3'),
  };
  const groups = run({ speakerData, sessionOrder: ['Kitchen', 'Sunroom', 'Living'] });
  assert.deepEqual(groups.map(g => g.speakers[0].name), ['Kitchen', 'Sunroom', 'Living']);
});
