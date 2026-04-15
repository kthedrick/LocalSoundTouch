// HTTP handler for /ha/* routes — Music Assistant integration

const http = require('http');
const { stopQueue, clearQueue, getAllPlayers, setMembers, pauseQueue, resumeQueue, nextTrack, prevTrack, getAllQueues, playMedia, getConfig } = require('./maClient');

// Look up HA media_player entity ID from Bose speaker name via haConfig.speakerEntities
function speakerNameToEntityId(name) {
  const cfg = getConfig();
  return cfg.speakerEntities?.[name] || null;
}

// GET request to HA REST API
function haGet(path) {
  const cfg = getConfig();
  const haUrl = new URL(cfg.haUrl || 'http://homeassistant:8123');
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: haUrl.hostname,
      port: parseInt(haUrl.port) || 8123,
      path,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + cfg.haToken },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Call HA REST API service
function haServicePost(path, body) {
  const cfg = getConfig();
  const haUrl = new URL(cfg.haUrl || 'http://homeassistant:8123');
  const bodyStr = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: haUrl.hostname,
      port: parseInt(haUrl.port) || 8123,
      path,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + cfg.haToken,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { resolve({}); }
    });
  });
}

function ok(res, data)  { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, ...data })); }
function err(res, msg)  { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: msg })); }

// Switch a Bose speaker to a specific input via its local HTTP API
function boseSwitchInput(ip, source, sourceAccount = '') {
  const body = `<ContentItem source="${source}" sourceAccount="${sourceAccount}" type="ad" location="" isPresetable="false"/>`;
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: ip, port: 8090, path: '/select', method: 'POST',
      headers: { 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// Apply groupSideEffects rules from haConfig after any group change.
// Checks current HA group state and flips HA switches as configured.
async function applyGroupSideEffects(involvedSpeakers = null) {
  const cfg = getConfig();
  const allRules = cfg.groupSideEffects || [];
  if (allRules.length === 0) return;
  // Only evaluate rules that include at least one of the speakers involved in the change
  const rules = involvedSpeakers
    ? allRules.filter(r => r.speakers.some(s => involvedSpeakers.includes(s)))
    : allRules;
  if (rules.length === 0) return;

  try {
    const entityMap = cfg.speakerEntities || {};
    const reverseMap = {};
    for (const [name, entityId] of Object.entries(entityMap)) reverseMap[entityId] = name;

    const allStates = await haGet('/api/states');
    const entityIds = new Set(Object.values(entityMap));
    const maStates = Array.isArray(allStates) ? allStates.filter(s => entityIds.has(s.entity_id)) : [];

    // Build current groups as sets of speaker names
    const currentGroups = [];
    for (const state of maStates) {
      const members = state.attributes?.group_members || [];
      if (members[0] !== state.entity_id) continue;
      const names = members.map(id => reverseMap[id]).filter(Boolean);
      if (names.length > 1) currentGroups.push(new Set(names));
    }

    for (const rule of rules) {
      const grouped = currentGroups.some(g => rule.speakers.every(s => g.has(s)));
      const desiredState = grouped ? rule.onGrouped : rule.onSeparated;
      const service = desiredState === 'on' ? 'turn_on' : 'turn_off';
      await haServicePost(`/api/services/switch/${service}`, { entity_id: rule.haSwitch });
      console.log('[sideEffect] %s → %s (grouped=%s)', rule.haSwitch, desiredState, grouped);
    }
  } catch (e) {
    console.error('[applyGroupSideEffects] error:', e.message);
  }
}

async function handleHa(req, res) {
  const url = req.url;

  // GET /ha/config — return haConfig (no token) for the UI
  if (url === '/ha/config' && req.method === 'GET') {
    const cfg = getConfig();
    const safe = { queues: cfg.queues || {}, speakerQueues: cfg.speakerQueues || {}, speakerEntities: cfg.speakerEntities || {}, favorites: cfg.favorites || [], playRedirects: cfg.playRedirects || [], releaseToTV: cfg.releaseToTV || [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(safe));
    return;
  }

  // GET /ha/queues — list all MA queues (for discovery)
  if (url === '/ha/queues' && req.method === 'GET') {
    try {
      const result = await getAllQueues();
      ok(res, { queues: result });
    } catch (e) { err(res, e.message); }
    return;
  }

  // POST /ha/clear — clear a queue (stop + remove all items so MA won't restart) { queueId }
  if (url === '/ha/clear' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const result = await clearQueue(body.queueId);
      console.log('[ha/clear] queueId=%s result=%j', body.queueId, result);
      ok(res, { result });
    } catch (e) {
      console.error('[ha/clear] error:', e.message);
      err(res, e.message);
    }
    return;
  }

  // GET /ha/browse-radio — list all radio stations from MA library via HA service
  if (url === '/ha/browse-radio' && req.method === 'GET') {
    try {
      // Discover MA config entry ID
      const entries = await haGet('/api/config/config_entries/entry');
      const entry = entries.find(e => e.domain === 'music_assistant');
      if (!entry) throw new Error('Music Assistant integration not found in HA');
      const config_entry_id = entry.entry_id;

      // Fetch both favorited and non-favorited radio stations
      const [favRes, nonFavRes] = await Promise.all([
        haServicePost('/api/services/music_assistant/get_library?return_response', { config_entry_id, media_type: 'radio', limit: 500, favorite: true }),
        haServicePost('/api/services/music_assistant/get_library?return_response', { config_entry_id, media_type: 'radio', limit: 500, favorite: false }),
      ]);
      const favItems    = favRes.body?.service_response?.items || [];
      const nonFavItems = nonFavRes.body?.service_response?.items || [];
      const allItems    = [...favItems, ...nonFavItems];
      const stations = allItems
        .map(i => ({ name: i.name, uri: i.uri, image: i.image || null }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stations));
    } catch (e) { err(res, e.message); }
    return;
  }

  // POST /ha/stop — stop a queue { queueId }
  if (url === '/ha/stop' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      await stopQueue(body.queueId);
      ok(res, {});
    } catch (e) { err(res, e.message); }
    return;
  }

  // POST /ha/release-to-tv — stop+clear speaker queue AND AirPlay group queue { speakerName }
  if (url === '/ha/release-to-tv' && req.method === 'POST') {
    const body = await readBody(req);
    const cfg = getConfig();
    const speakerQueueId = cfg.speakerQueues?.[body.speakerName];
    const groupQueueId   = cfg.queues?.airplayGroup;
    try {
      const ops = [];
      if (speakerQueueId) ops.push(stopQueue(speakerQueueId).then(() => clearQueue(speakerQueueId)));
      if (groupQueueId)   ops.push(stopQueue(groupQueueId).then(() => clearQueue(groupQueueId)));
      await Promise.allSettled(ops);
      ok(res, {});
    } catch (e) { err(res, e.message); }
    return;
  }

  // POST /ha/pause — pause a queue { queueId }
  if (url === '/ha/pause' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      await pauseQueue(body.queueId);
      ok(res, {});
    } catch (e) { err(res, e.message); }
    return;
  }

  // POST /ha/resume — resume a queue { queueId }
  if (url === '/ha/resume' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      await resumeQueue(body.queueId);
      ok(res, {});
    } catch (e) { err(res, e.message); }
    return;
  }

  // POST /ha/next — next track { queueId }
  if (url === '/ha/next' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      await nextTrack(body.queueId);
      ok(res, {});
    } catch (e) { err(res, e.message); }
    return;
  }

  // POST /ha/prev — previous track { queueId }
  if (url === '/ha/prev' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      await prevTrack(body.queueId);
      ok(res, {});
    } catch (e) { err(res, e.message); }
    return;
  }

  // POST /ha/play — play a favorite { queueId, uri }
  if (url === '/ha/play' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const cfg = getConfig();
      let { queueId, uri } = body;

      // Check playRedirects: intercept play for speakers with special routing
      const redirect = (cfg.playRedirects || []).find(r => r.fromQueue === queueId);
      if (redirect) {
        if (redirect.boseSwitchInput) {
          const { ip, source, sourceAccount = '' } = redirect.boseSwitchInput;
          console.log('[ha/play] redirect: switching %s to input %s', ip, source);
          await boseSwitchInput(ip, source, sourceAccount);
        }
        queueId = redirect.toQueue;
        console.log('[ha/play] redirect: playing on %s instead', queueId);
      }

      const result = await playMedia(queueId, uri);
      console.log('[ha/play] queueId=%s uri=%s result=%j', queueId, uri, result);
      ok(res, { result });
    } catch (e) {
      console.error('[ha/play] error:', e.message);
      err(res, e.message);
    }
    return;
  }

  // GET /ha/schema — fetch MA's API schema for debugging
  if (url === '/ha/schema' && req.method === 'GET') {
    const { maPost: _, getConfig, ...rest } = require('./maClient');
    const cfg = getConfig();
    const maUrl = new URL(cfg.maUrl || 'http://localhost:8095');
    const http = require('http');
    const proxyReq = http.request({
      hostname: maUrl.hostname,
      port: parseInt(maUrl.port) || 8095,
      path: '/openapi.json',
      method: 'GET',
    }, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    });
    proxyReq.on('error', e => { res.writeHead(500); res.end(e.message); });
    proxyReq.end();
    return;
  }

  // GET /ha/queue-now-playing?queueId=... — return current track info from MA queue
  if (url.startsWith('/ha/queue-now-playing') && req.method === 'GET') {
    const queueId = new URL('http://x' + url).searchParams.get('queueId');
    try {
      const queues = await getAllQueues();
      const queue = Array.isArray(queues) ? queues.find(q => q.queue_id === queueId) : null;
      const item = queue?.current_item;
      const meta = item?.streamdetails?.stream_metadata;
      const mediaType = item?.media_item?.media_type || item?.streamdetails?.media_type || null;
      const stationName = mediaType === 'radio' ? (item?.media_item?.name || item?.name || null) : null;
      const provider = item?.streamdetails?.provider || null;
      ok(res, {
        track:    meta?.title  || item?.name || null,
        artist:   meta?.artist || null,
        album:    meta?.album  || null,
        art:      meta?.image_url || item?.image?.path || null,
        uri:      item?.media_item?.uri || null,
        duration: item?.duration || 0,
        position: queue?.elapsed_time || 0,
        positionUpdatedAt: queue?.elapsed_time_last_updated || null,
        mediaType,
        stationName,
        provider,
      });
    } catch (e) { err(res, e.message); }
    return;
  }

  // GET /ha/queue-uri?queueId=... — return current playing URI for a queue
  if (url.startsWith('/ha/queue-uri') && req.method === 'GET') {
    const queueId = new URL('http://x' + url).searchParams.get('queueId');
    try {
      const queues = await getAllQueues();
      const queue = Array.isArray(queues) ? queues.find(q => q.queue_id === queueId) : null;
      const uri = queue?.current_item?.media_item?.uri || null;
      ok(res, { uri });
    } catch (e) { err(res, e.message); }
    return;
  }

  // POST /ha/debug — log client state for debugging
  if (url === '/ha/debug' && req.method === 'POST') {
    const body = await readBody(req);
    console.log('[ha/debug]', JSON.stringify(body));
    ok(res, {});
    return;
  }

  // POST /ha/group-include — join speakers into master's MA group
  // Accepts { masterName, speakerName } (single) or { masterName, speakerNames } (array)
  if (url === '/ha/group-include' && req.method === 'POST') {
    const body = await readBody(req);
    const masterEntity = speakerNameToEntityId(body.masterName);
    const names = body.speakerNames || (body.speakerName ? [body.speakerName] : []);
    const targetEntities = names.map(n => speakerNameToEntityId(n)).filter(Boolean);
    if (!masterEntity || targetEntities.length === 0) {
      const missing = !masterEntity ? body.masterName : names.filter(n => !speakerNameToEntityId(n)).join(', ');
      err(res, `No HA entity mapped for: ${missing}`);
      return;
    }
    try {
      const result = await haServicePost('/api/services/media_player/join', {
        entity_id: masterEntity,
        group_members: targetEntities,
      });
      console.log('[ha/group-include] %s + [%s] → status=%d', masterEntity, targetEntities.join(', '), result.status);
      ok(res, { status: result.status });
    } catch (e) {
      console.error('[ha/group-include] error:', e.message);
      err(res, e.message);
      return;
    }
    // Apply per-member side effects (e.g. Bedroom → switch Bose to AUX1 for Belkin)
    const cfg2 = getConfig();
    for (const speakerName of names) {
      const redirect = (cfg2.playRedirects || []).find(r => r.speakerName === speakerName && r.boseSwitchInput);
      if (redirect) {
        const { ip, source, sourceAccount = '' } = redirect.boseSwitchInput;
        boseSwitchInput(ip, source, sourceAccount)
          .then(() => console.log('[group-include] switched %s to %s', ip, source))
          .catch(e => console.error('[group-include] boseSwitchInput error:', e.message));
      }
    }
    setTimeout(() => applyGroupSideEffects([body.masterName, ...names]), 1500);
    return;
  }

  // POST /ha/group-remove — unjoin a speaker from its MA group { speakerName }
  if (url === '/ha/group-remove' && req.method === 'POST') {
    const body = await readBody(req);
    const targetEntity = speakerNameToEntityId(body.speakerName);
    if (!targetEntity) {
      err(res, `No HA entity mapped for: ${body.speakerName}`);
      return;
    }
    try {
      const result = await haServicePost('/api/services/media_player/unjoin', {
        entity_id: targetEntity,
      });
      console.log('[ha/group-remove] %s → status=%d', targetEntity, result.status);
      ok(res, { status: result.status });
    } catch (e) {
      console.error('[ha/group-remove] error:', e.message);
      err(res, e.message);
      return;
    }
    setTimeout(() => applyGroupSideEffects([body.speakerName]), 1500);
    return;
  }

  // GET /ha/group-state — return active MA speaker groups from HA entity state
  if (url === '/ha/group-state' && req.method === 'GET') {
    try {
      const cfg = getConfig();
      const entityMap = cfg.speakerEntities || {};
      // Build reverse map: entity_id → speaker_name
      const reverseMap = {};
      for (const [name, entityId] of Object.entries(entityMap)) reverseMap[entityId] = name;

      // Fetch all HA states and filter to our MA entities
      const allStates = await haGet('/api/states');
      const entityIds = new Set(Object.values(entityMap));
      const maStates = Array.isArray(allStates)
        ? allStates.filter(s => entityIds.has(s.entity_id))
        : [];

      // Find groups: the leader entity lists other known entities in its group_members.
      // MA/HA behavior varies — sometimes leader includes itself in the list, sometimes not.
      // Use deduplication by member set to avoid symmetric duplicates.
      const groups = [];
      const seenKeys = new Set();
      for (const state of maStates) {
        const members = state.attributes?.group_members || [];
        const otherMembers = members.filter(id => id !== state.entity_id && reverseMap[id]);
        if (otherMembers.length === 0) continue;
        const leaderName = reverseMap[state.entity_id];
        if (!leaderName) continue;
        const memberNames = otherMembers.map(id => reverseMap[id]).filter(Boolean);
        const key = [leaderName, ...memberNames].sort().join('\0');
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        groups.push({ leader: leaderName, members: memberNames });
      }
      ok(res, { groups });
    } catch (e) { err(res, e.message); }
    return;
  }

  // GET /ha/ma-entities — list HA media_player entities (filtered to likely MA ones)
  if (url === '/ha/ma-entities' && req.method === 'GET') {
    try {
      const allStates = await haGet('/api/states');
      const players = Array.isArray(allStates)
        ? allStates
            .filter(s => s.entity_id.startsWith('media_player.') && !s.entity_id.includes('stp_'))
            .map(s => ({ entity_id: s.entity_id, name: s.attributes?.friendly_name || s.entity_id }))
            .sort((a, b) => a.entity_id.localeCompare(b.entity_id))
        : [];
      ok(res, { players });
    } catch (e) { err(res, e.message); }
    return;
  }

  // GET /ha/tv-state — LG TV + Apple TV now-playing
  if (url === '/ha/tv-state' && req.method === 'GET') {
    try {
      const cfg = getConfig();
      const tv = cfg.tvConfig || {};
      if (!tv.lgTvEntity) { ok(res, { ok: true, tv: null }); return; }

      const lgState = await haGet('/api/states/' + tv.lgTvEntity);
      if (!lgState || lgState.state === 'off' || lgState.state === 'unavailable') {
        ok(res, { ok: true, tv: { on: false } });
        return;
      }

      const source = lgState.attributes?.source || '';
      const result = { ok: true, tv: { on: true, source } };

      if (tv.appleTvEntity && source === tv.appleTvSource) {
        const atState = await haGet('/api/states/' + tv.appleTvEntity);
        result.tv.appleTV = {
          title:  atState?.attributes?.media_title  || null,
          artist: atState?.attributes?.media_artist || null,
          app:    atState?.attributes?.app_name     || null,
          art:    atState?.attributes?.entity_picture ? ('http://homeassistant:8123' + atState.attributes.entity_picture) : null,
          state:  atState?.state || null,
        };
      } else {
        result.tv.appName = lgState.attributes?.app_name || source;
        result.tv.sourceList = lgState.attributes?.source_list || [];
      }

      ok(res, result);
    } catch (e) { err(res, e.message); }
    return;
  }

  // GET /ha/raw-states — dump raw HA state for all speakerEntities (debug)
  if (url === '/ha/raw-states' && req.method === 'GET') {
    try {
      const cfg = getConfig();
      const entityIds = new Set(Object.values(cfg.speakerEntities || {}));
      const allStates = await haGet('/api/states');
      const relevant = Array.isArray(allStates)
        ? allStates
            .filter(s => entityIds.has(s.entity_id))
            .map(s => ({ entity_id: s.entity_id, state: s.state, group_members: s.attributes?.group_members || [] }))
        : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(relevant, null, 2));
    } catch (e) { err(res, e.message); }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

module.exports = handleHa;
