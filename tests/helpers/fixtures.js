// Fixture config + MA/HA state builders. Topology mirrors the real setup
// (sanitized): Bose speakers, Bedroom→Belkin playRedirect, WiiM, bass side effect.
const fs = require('fs');

// Queue/player IDs used across handler tests
const Q = {
  sunroom:  'q-sunroom',
  living:   'q-living',
  kitchen:  'q-kitchen',
  bedroom:  'q-bedroom',   // Bose-Bedroom's own queue (redirect intercept key)
  belkin:   'q-belkin',    // Belkin AirPlay adapter (redirect target)
  joshua:   'q-joshua',
  rosemary: 'q-rosemary',
  wiim:     'wiim_uuid:TEST-BASEMENT',
  airplayGroup: 'q-syncgroup',
};

const E = {
  sunroom:  'media_player.bose_sunroom_300_6',
  living:   'media_player.bose_living_room_6',
  kitchen:  'media_player.bose_kitchen_6',
  bedroom:  'media_player.bose_bathroom2', // Belkin entity, real-world naming quirk
  joshua:   'media_player.bose_joshua_6',
  rosemary: 'media_player.bose_rosemary_6',
  wiim:     'media_player.wiim_basement',
};

function baseConfig(mockPort) {
  const base = `http://127.0.0.1:${mockPort}`;
  return {
    haUrl: base,
    haToken: 'test-ha-token',
    maUrl: base,
    maToken: 'test-ma-token',
    queues: { sunroom: Q.sunroom, airplayGroup: Q.airplayGroup },
    speakerEntities: {
      'Bose-Sunroom 300': E.sunroom,
      'Bose-Living Room': E.living,
      'Bose-Kitchen':     E.kitchen,
      'Bose-Bedroom':     E.bedroom,
      'Bose-Joshua':      E.joshua,
      'Bose-Rosemary':    E.rosemary,
      'WiiM Basement':    E.wiim,
    },
    speakerQueues: {
      'Bose-Sunroom 300': Q.sunroom,
      'Bose-Living Room': Q.living,
      'Bose-Kitchen':     Q.kitchen,
      'Bose-Bedroom':     Q.bedroom,
      'Bose-Joshua':      Q.joshua,
      'Bose-Rosemary':    Q.rosemary,
      'WiiM Basement':    Q.wiim,
    },
    playRedirects: [{
      speakerName: 'Bose-Bedroom',
      fromQueue: Q.bedroom,
      toQueue:   Q.belkin,
      boseSwitchInput: { ip: '127.0.0.1', source: 'AUX', sourceAccount: 'AUX1' },
    }],
    groupSideEffects: [{
      speakers: ['Bose-Sunroom 300', 'Bose-Living Room'],
      haSwitch: 'switch.living_room_bass',
      onGrouped: 'on', onSeparated: 'off',
    }],
    speakerToggles: [{
      speakerName: 'Bose-Living Room',
      entity: 'switch.living_room_bass',
      label: 'Bass',
    }],
    features: {},
    favorites: [],
    presetActions: {},
    releaseToTV: [],
  };
}

// Write fixture haConfig to LST_HA_CONFIG and reload maClient's cache.
function writeHaConfig({ mockPort, overrides = {} }) {
  const cfg = { ...baseConfig(mockPort), ...overrides };
  fs.writeFileSync(process.env.LST_HA_CONFIG, JSON.stringify(cfg, null, 2));
  require('../../maClient').reloadConfig();
  return cfg;
}

function writeNasConfig({ host = '127.0.0.1', username = 'nasuser', password = 'naspass' } = {}) {
  const cfg = { host, username, password };
  fs.writeFileSync(process.env.LST_NAS_CONFIG, JSON.stringify(cfg));
  return cfg;
}

// MA players/all item
function maPlayer(playerId, { name = playerId, state = 'idle', synced_to = null, can_group_with = [], group_members = [], available = true } = {}) {
  return { player_id: playerId, name, state, synced_to, can_group_with, group_members, available, provider: 'test', type: 'player' };
}

// HA /api/states item
function haState(entityId, groupMembers = [], state = 'playing', extraAttrs = {}) {
  return { entity_id: entityId, state, attributes: { group_members: groupMembers, ...extraAttrs } };
}

module.exports = { Q, E, writeHaConfig, writeNasConfig, maPlayer, haState };
