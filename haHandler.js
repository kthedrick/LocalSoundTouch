// HTTP handler for /ha/* routes — Music Assistant integration

const http = require('http');
const { stopQueue, clearQueue, getAllPlayers, groupPlayer, ungroupPlayer, setMembers, pauseQueue, resumeQueue, nextTrack, prevTrack, getAllQueues, playMedia, setPlayerVolume, getConfig, maPost, resolveQueueRedirect } = require('./maClient');
const pandoraTracker = require('./pandoraTracker');

// Bose speaker HTTP API port (env override for tests)
const BOSE_PORT = parseInt(process.env.LST_BOSE_PORT) || 8090;

// Track the station URI most recently played on each queue (for stop→rejoin→restart)
const activeStationUris = {};

// Per-queue Pandora track-start state: { trackKey, startElapsed } — lets us compute per-track position from cumulative elapsed_time
const pandoraPositionState = {};

// Queue-health debounce: only surface a mismatch if it persisted across the previous poll too.
// Kills transient flashes during track/source transitions (e.g. brief STANDBY at end-of-track).
let prevQueueHealthKeys = new Set();

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
    req.setTimeout(10000, () => req.destroy(new Error('HA GET timeout: ' + path)));
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
    req.setTimeout(15000, () => req.destroy(new Error('HA service timeout: ' + path)));
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

// Resolve playRedirects for a play request: switches the Bose to the configured input
// (e.g. Bedroom → AUX1 for the Belkin adapter) and returns the queue that actually
// receives playback. ALL play paths must route through this, not just /ha/play.
async function applyRedirect(queueId) {
  const { queueId: resolved, redirect } = resolveQueueRedirect(queueId);
  if (redirect?.boseSwitchInput) {
    const { ip, source, sourceAccount = '' } = redirect.boseSwitchInput;
    console.log('[redirect] switching %s to input %s, playing on %s', ip, source, resolved);
    await boseSwitchInput(ip, source, sourceAccount).catch(e =>
      console.error('[redirect] boseSwitchInput error:', e.message));
  }
  return resolved;
}

// Switch a Bose speaker to a specific input via its local HTTP API
function boseSwitchInput(ip, source, sourceAccount = '') {
  const body = `<ContentItem source="${source}" sourceAccount="${sourceAccount}" type="ad" location="" isPresetable="false"/>`;
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: ip, port: BOSE_PORT, path: '/select', method: 'POST',
      headers: { 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve(data));
    });
    req.setTimeout(5000, () => req.destroy(new Error('Bose /select timeout: ' + ip)));
    req.on('error', reject);
    req.write(body); req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// GET from a Bose speaker's local HTTP API (returns raw body string)
function boseGet(ip, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: ip, port: BOSE_PORT, path, method: 'GET' }, (res) => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve(data));
    });
    req.setTimeout(5000, () => req.destroy(new Error('Bose GET timeout: ' + ip + path)));
    req.on('error', reject);
    req.end();
  });
}

// Send a Bose key (press + release) via the speaker's local HTTP API
function boseKey(ip, key) {
  const send = state => new Promise((resolve, reject) => {
    const body = `<key state="${state}" sender="Gabbo">${key}</key>`;
    const req = http.request({
      hostname: ip, port: BOSE_PORT, path: '/key', method: 'POST',
      headers: { 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.setTimeout(5000, () => req.destroy(new Error('Bose /key timeout: ' + ip)));
    req.on('error', reject);
    req.write(body); req.end();
  });
  return send('press').then(() => sleep(100)).then(() => send('release'));
}

// Hard reboot via the SoundTouch diagnostic console (TCP 17000, open on LAN).
// The only API-level way to fully re-initialize the ST300's HDMI board.
function boseConsoleReboot(ip) {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: ip, port: 17000 });
    sock.setTimeout(5000);
    sock.on('connect', () => { sock.write('sys reboot\r\n'); setTimeout(() => { sock.destroy(); resolve(); }, 1000); });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('console timeout: ' + ip)); });
    sock.on('error', reject);
  });
}

// LG TV state relevant to ARC reset. arcOutput = the output to restore after the
// tv_speaker bounce (usually "external_arc").
async function getLgTvState() {
  const cfg = getConfig();
  const entity = cfg.tvConfig?.lgTvEntity;
  if (!entity) return { on: false };
  const state = await haGet('/api/states/' + entity).catch(() => null);
  const on = !!state && !['off', 'unavailable', 'unknown'].includes(state.state);
  const soundOut = state?.attributes?.sound_output;
  return {
    entity, on,
    source: state?.attributes?.source || '',
    arcOutput: soundOut && soundOut !== 'tv_speaker' ? soundOut : 'external_arc',
  };
}

// haServicePost resolves on ANY HTTP status — webostv returns 500 when HA has no
// live connection to the TV ("Device is off and cannot be controlled"). This wrapper
// turns HTTP errors into throws so callers can't mistake a failed call for success.
async function haServiceCall(path, body) {
  const resp = await haServicePost(path, body);
  if (resp.status >= 400) {
    const detail = typeof resp.body === 'object' ? JSON.stringify(resp.body) : String(resp.body);
    throw new Error(`HA ${path} → ${resp.status}: ${detail.slice(0, 200)}`);
  }
  return resp;
}

async function wakeAppleTv() {
  const cfg = getConfig();
  const mediaEntity = cfg.tvConfig?.appleTvEntity;
  if (!mediaEntity) return null;
  const remoteEntity = cfg.tvConfig?.appleTvRemoteEntity || mediaEntity.replace(/^media_player\./, 'remote.');
  await haServiceCall('/api/services/remote/turn_on', { entity_id: remoteEntity });
  await sleep(500);
  await haServiceCall('/api/services/remote/send_command', { entity_id: remoteEntity, command: 'home' });
  return remoteEntity;
}

// Stop + clear a speaker's MA queue and the shared AirPlay group queue so MA/HA
// can't grab the speaker back mid-reset.
async function releaseSpeakerQueues(speakerName) {
  const cfg = getConfig();
  const speakerQueueId = cfg.speakerQueues?.[speakerName];
  const groupQueueId   = cfg.queues?.airplayGroup;
  const hybrid = require('./hybridOrchestrator');
  if (speakerQueueId) hybrid.stop(speakerQueueId);
  if (groupQueueId)   hybrid.stop(groupQueueId);
  const ops = [];
  if (speakerQueueId) ops.push(stopQueue(speakerQueueId).then(() => clearQueue(speakerQueueId)));
  if (groupQueueId)   ops.push(stopQueue(groupQueueId).then(() => clearQueue(groupQueueId)));
  await Promise.allSettled(ops);
}

// ARC re-handshake: hand TV audio to its internal speakers, put the Bose on the TV
// input (wakes it from standby), then hand audio back to ARC so the TV re-negotiates
// with a live soundbar. Wakes the Apple TV first if it was the active input, so an
// HDMI signal is present during the handshake. Any step that fails lands in
// `warnings` — the ARC bounce is the whole point of this reset, so a swallowed
// failure here makes the reset a silent no-op.
async function arcResetSequence(ip, step) {
  const cfg = getConfig();
  const tv = await getLgTvState();
  const warnings = [];
  const warn = msg => { warnings.push(msg); console.warn('[reset-tv]', msg); };
  const lgOut = async (output) => {
    try { await haServiceCall('/api/services/webostv/select_sound_output', { entity_id: tv.entity, sound_output: output }); }
    catch (e) { warn(`LG sound output → ${output} failed (ARC bounce did NOT happen): ${e.message}`); }
  };
  if (tv.on) { await lgOut('tv_speaker'); await sleep(step); }
  if (tv.on && cfg.tvConfig?.appleTvEntity && tv.source === cfg.tvConfig?.appleTvSource) {
    try { await wakeAppleTv(); } catch (e) { warn('Apple TV wake failed: ' + e.message); }
    await sleep(step);
  }
  await boseSwitchInput(ip, 'PRODUCT', 'TV');
  await sleep(step);
  if (tv.on) await lgOut(tv.arcOutput);
  return { tv, warnings };
}

// Compute active MA speaker groups — shared by /ha/group-state and applyGroupSideEffects.
// Primary: HA entity group_members ("any entity with OTHER known entities in its
// group_members is a leader" — do NOT use members[0] === entity_id, it breaks for the
// Joshua/Rosemary pattern). Supplement: MA players/all synced_to (updates immediately
// after players/cmd/group while HA entity state lags). Returns [{ leader, members }].
async function getActiveGroups() {
  const cfg = getConfig();
  const entityMap = cfg.speakerEntities || {};
  const reverseMap = {};
  for (const [name, entityId] of Object.entries(entityMap)) reverseMap[entityId] = name;

  // Build name↔queue maps for MA player lookup
  const queueToName = {};
  for (const [name, queueId] of Object.entries(cfg.speakerQueues || {})) {
    queueToName[queueId] = name;
  }
  // playRedirects targets (e.g. Belkin adapter for Bose-Bedroom) must resolve to speakerName
  for (const r of (cfg.playRedirects || [])) {
    if (r.toQueue && r.speakerName) queueToName[r.toQueue] = r.speakerName;
  }

  // Fetch HA states and MA players in parallel
  const [allStates, maPlayers] = await Promise.all([
    haGet('/api/states'),
    getAllPlayers().catch(() => []),
  ]);

  // ── Step 1: HA-based group detection ────────────────────────────────────
  // Catches WiiM speakers and any speaker not in speakerQueues.
  const entityIds = new Set(Object.values(entityMap));
  const maStates = Array.isArray(allStates)
    ? allStates.filter(s => entityIds.has(s.entity_id))
    : [];

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

  // Drop strict subsets (stale entities with incomplete group_members)
  const fullSets = groups.map(g => new Set([g.leader, ...g.members]));
  const filtered = groups.filter((_, i) =>
    !fullSets.some((other, j) =>
      j !== i && fullSets[i].size < other.size &&
      [...fullSets[i]].every(m => other.has(m))
    )
  );

  // ── Step 2: MA synced_to supplementation ────────────────────────────────
  // players/cmd/group updates MA state immediately but HA entity state lags.
  // For each player that has synced_to set, ensure it appears in the right group.
  if (Array.isArray(maPlayers)) {
    for (const player of maPlayers) {
      const memberName = queueToName[player.player_id];
      const leaderName = queueToName[player.synced_to];
      if (!memberName || !leaderName || !player.synced_to) continue;

      // Find existing group that contains the leader or member
      let group = filtered.find(g =>
        g.leader === leaderName || g.members.includes(leaderName) ||
        g.leader === memberName || g.members.includes(memberName)
      );
      if (!group) {
        // No HA group yet — create one from MA data alone
        group = { leader: leaderName, members: [] };
        filtered.push(group);
      }
      // Ensure leader is correct and member is present
      if (group.leader !== leaderName && !group.members.includes(leaderName)) {
        group.members.push(leaderName);
      }
      if (group.leader !== memberName && !group.members.includes(memberName)) {
        group.members.push(memberName);
      }
    }
  }

  // ── Step 3: Leader correction using MA synced_to=null ───────────────────
  // The player with synced_to=null owns the active queue; promote it to leader.
  if (Array.isArray(maPlayers)) {
    for (const group of filtered) {
      const allNames = new Set([group.leader, ...group.members]);
      const trueLeader = maPlayers.find(p => {
        const name = queueToName[p.player_id];
        return name && allNames.has(name) && p.synced_to === null && p.state !== 'idle';
      });
      if (trueLeader) {
        const trueLeaderName = queueToName[trueLeader.player_id];
        if (trueLeaderName && trueLeaderName !== group.leader) {
          group.members = group.members.filter(m => m !== trueLeaderName);
          group.members.push(group.leader);
          group.leader = trueLeaderName;
        }
      }
    }
  }

  return filtered;
}

// Apply groupSideEffects rules from haConfig after any group change.
// Uses getActiveGroups() (HA + MA combined) — the raw HA-only members[0] check
// misdetected leaders and flipped switches wrongly for some group_members shapes.
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
    const currentGroups = (await getActiveGroups()).map(g => new Set([g.leader, ...g.members]));

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
    const safe = { queues: cfg.queues || {}, speakerQueues: cfg.speakerQueues || {}, speakerEntities: cfg.speakerEntities || {}, favorites: cfg.favorites || [], playRedirects: cfg.playRedirects || [], releaseToTV: cfg.releaseToTV || [], features: cfg.features || {} };
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
    require('./hybridOrchestrator').stop(body.queueId);
    // Hybrid sessions for redirected speakers are keyed by the redirect target queue
    require('./hybridOrchestrator').stop(resolveQueueRedirect(body.queueId).queueId);
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

  // GET /ha/browse-ma?uri=<encoded_uri>&name=<item_name> — browse MA library tree
  if (url.startsWith('/ha/browse-ma') && req.method === 'GET') {
    const params = new URL('http://x' + url).searchParams;
    const uri  = params.get('uri')  || '';
    const name = params.get('name') || '';
    try {
      const { maPost } = require('./maClient');

      // Helper: map a raw MA item to our browse item shape
      const toItem = (i) => {
        const mt = (i.media_type || '').toLowerCase();
        const isLeaf = mt === 'track' || mt === 'radio';
        let itemName = i.name || '';
        if (!itemName && i.uri) {
          const pathPart = i.uri.replace(/^[^:]+:\/\//, '').split('/').filter(Boolean).pop() || '';
          itemName = pathPart.charAt(0).toUpperCase() + pathPart.slice(1);
        }
        return {
          name:      itemName,
          uri:       i.uri,
          image:     i.image || null,
          mediaType: mt,
          canPlay:   mt !== 'folder' && mt !== '',
          canExpand: !isLeaf,
        };
      };

      // Is this an album URI? (library://album/N or provider://album/...)
      const albumMatch = uri.match(/\/album[s]?\/([^\/]+)/);
      const isAlbumUri = !!albumMatch;

      // For album URIs: use music/albums/album_tracks (proper API, works reliably)
      if (isAlbumUri) {
        const itemId = albumMatch[1];
        const providerDomainForAlbum = uri.split('--')[0].split('://')[0] || 'library';
        try {
          const tracks = await maPost('music/albums/album_tracks', {
            item_id: itemId,
            provider_instance_id_or_domain: providerDomainForAlbum,
            in_library_only: false,
          });
          if (Array.isArray(tracks) && tracks.length > 0) {
            const sorted = tracks.sort((a, b) => {
              if (a.disc_number !== b.disc_number) return (a.disc_number || 0) - (b.disc_number || 0);
              return (a.track_number || 0) - (b.track_number || 0);
            });
            const trackItems = sorted.map(t => ({
              name:      (t.disc_number > 1 ? t.disc_number + '-' : '') + (t.track_number ? t.track_number + '. ' : '') + t.name,
              uri:       t.uri,
              image:     t.image || null,
              mediaType: 'track',
              canPlay:   true,
              canExpand: false,
            }));
            ok(res, { title: name, items: trackItems });
            return;
          }
        } catch (e) { console.warn('[browse-ma] album_tracks failed:', e.message); }
      }

      // Try music/browse for non-album URIs
      const browseResult = await maPost('music/browse', uri ? { path: uri } : {});
      const browseItems = Array.isArray(browseResult)
        ? browseResult.filter(i => i.name !== '..').map(toItem)
        : [];

      if (browseItems.length > 0) {
        ok(res, { title: '', items: browseItems });
        return;
      }

      // Last fallback: use get_library filtered by provider and folder type
      const providerDomain = uri ? uri.split('--')[0].split('://')[0] : null;
      // Infer what type to fetch from the folder path (e.g. /folder/albums → album only)
      const folderPath = uri ? uri.replace(/^[^:]+:\/\//, '').toLowerCase() : '';
      const wantAlbums  = !folderPath || folderPath.includes('album');
      const wantArtists = !folderPath || folderPath.includes('artist');
      const wantPlaylists = folderPath.includes('playlist');
      const wantTracks  = folderPath.includes('track');

      const entries = await haGet('/api/config/config_entries/entry');
      const entry = entries.find(e => e.domain === 'music_assistant');
      if (!entry) throw new Error('Music Assistant not found in HA');
      const config_entry_id = entry.entry_id;

      const fetchType = async (media_type) => {
        const r = await haServicePost('/api/services/music_assistant/get_library?return_response',
          { config_entry_id, media_type, limit: 500 });
        return r.body?.service_response?.items || [];
      };

      const filterByProvider = (items) => {
        if (!providerDomain || providerDomain === 'library' || providerDomain === 'builtin') return items;
        const filtered = items.filter(i =>
          (i.provider_mappings || []).some(m => m.provider_domain === providerDomain)
        );
        return filtered.length ? filtered : items;
      };

      const resultItems = [];
      if (wantArtists && !wantAlbums && !wantPlaylists && !wantTracks) {
        const raw = filterByProvider(await fetchType('artist'));
        raw.forEach(i => resultItems.push({ name: i.name, uri: i.uri, image: i.image || null, mediaType: 'artist', canPlay: true, canExpand: true }));
      } else if (wantPlaylists) {
        const raw = filterByProvider(await fetchType('playlist'));
        raw.forEach(i => resultItems.push({ name: i.name, uri: i.uri, image: i.image || null, mediaType: 'playlist', canPlay: true, canExpand: false }));
      } else if (wantTracks) {
        const raw = filterByProvider(await fetchType('track'));
        raw.forEach(i => resultItems.push({ name: i.name, uri: i.uri, image: i.image || null, mediaType: 'track', canPlay: true, canExpand: false }));
      } else {
        // Albums (default) — also include artists for mixed views
        const [rawAlbums, rawArtists] = await Promise.all([
          wantAlbums  ? fetchType('album')  : Promise.resolve([]),
          wantArtists ? fetchType('artist') : Promise.resolve([]),
        ]);
        filterByProvider(rawArtists).forEach(i => resultItems.push({ name: i.name, uri: i.uri, image: i.image || null, mediaType: 'artist', canPlay: true, canExpand: true }));
        filterByProvider(rawAlbums).forEach(i => resultItems.push({ name: i.name, uri: i.uri, image: i.image || null, mediaType: 'album', canPlay: true, canExpand: true }));
      }

      const items = resultItems.sort((a, b) => a.name.localeCompare(b.name));

      ok(res, { title: '', items });
    } catch (e) { err(res, e.message); }
    return;
  }

  // GET /ha/search-radio?q=<query> — search MA for radio stations, returns name+uri
  if (url.startsWith('/ha/search-radio') && req.method === 'GET') {
    const q = new URL('http://x' + url).searchParams.get('q') || '';
    try {
      const { maPost } = require('./maClient');
      const result = await maPost('music/search', { search_query: q, media_types: ['radio'], limit: 10 });
      const stations = (result?.radio || []).map(s => ({ name: s.name, uri: s.uri }));
      ok(res, stations);
    } catch (e) { err(res, e.message); }
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
      console.log('[ha/stop] queueId=%s', body.queueId);
      ok(res, {});
    } catch (e) { err(res, e.message); }
    return;
  }

  // POST /ha/release-to-tv — stop+clear speaker queue AND AirPlay group queue { speakerName }
  if (url === '/ha/release-to-tv' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      await releaseSpeakerQueues(body.speakerName);
      ok(res, {});
    } catch (e) { err(res, e.message); }
    return;
  }

  // POST /ha/reset-tv-audio — HDMI/ARC audio reset for the ST300 { speakerName, ip, hard? }
  // Soft: MA release → Bose to standby → LG drops ARC (tv_speaker) → Bose wakes on TV
  // input → LG re-grabs ARC. Fixes the dead-HDMI-audio state without a reboot.
  // Hard: MA release → console reboot (TCP 17000) → responds immediately; background
  // waits for the speaker to come back, then runs the same ARC re-handshake.
  if (url === '/ha/reset-tv-audio' && req.method === 'POST') {
    const body = await readBody(req);
    const ip = body.ip;
    if (!ip) { err(res, 'ip required'); return; }
    const step = parseInt(process.env.LST_RESET_STEP_MS) || 2500;
    try {
      await releaseSpeakerQueues(body.speakerName);

      if (body.hard) {
        await boseConsoleReboot(ip);
        console.log('[reset-tv] %s console reboot issued', ip);
        ok(res, { rebooting: true });
        (async () => {
          await sleep(15000);  // let it actually go down before polling
          const deadline = Date.now() + 180000;
          while (Date.now() < deadline) {
            try { await boseGet(ip, '/info'); break; } catch { await sleep(5000); }
          }
          await sleep(8000);   // audio subsystem settles after HTTP comes back
          const seq = await arcResetSequence(ip, step).catch(e => ({ warnings: [e.message] }));
          console.log('[reset-tv] hard reset complete for %s tvOn=%s warnings=%j', ip, seq.tv?.on, seq.warnings);
        })().catch(e => console.error('[reset-tv] background error:', e.message));
        return;
      }

      // Soft: power-cycle to standby first (unless already there), then re-handshake
      const np = await boseGet(ip, '/now_playing').catch(() => '');
      const inStandby = /source="STANDBY"/.test(np);
      if (!inStandby) { await boseKey(ip, 'POWER'); await sleep(step); }
      const { tv, warnings } = await arcResetSequence(ip, step);
      // Detect an AirPlay client (usually the Apple TV) re-grabbing the speaker —
      // it steals the input back and, worse, means no audio flows over HDMI at all.
      await sleep(step);
      const after = await boseGet(ip, '/now_playing').catch(() => '');
      if (/source="AIRPLAY"/.test(after) && /PLAY_STATE/.test(after)) {
        warnings.push('An AirPlay device re-grabbed the speaker right after the reset — probably the Apple TV. Set its audio output to TV Speakers (hold TV button on Siri remote → Audio), then run the reset again.');
      }
      console.log('[reset-tv] soft reset done for %s tvOn=%s warnings=%j', ip, tv.on, warnings);
      ok(res, { reset: 'soft', tvOn: tv.on, warnings });
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
      const result = await resumeQueue(body.queueId);
      console.log('[ha/resume] queueId=%s result=%j', body.queueId, result);
      ok(res, {});
    } catch (e) { console.error('[ha/resume] error:', e.message); err(res, e.message); }
    return;
  }

  // POST /ha/next — next track { queueId, pandora? }
  if (url === '/ha/next' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      if (body.pandora) {
        // WORKAROUND: MA next-track is broken for Pandora radio — it silently does nothing.
        // Pause→play causes Pandora to start a new song on the station, which is the best
        // available substitute. Remove this branch when MA fixes native Pandora next-track.
        await pauseQueue(body.queueId);
        await new Promise(r => setTimeout(r, 800));
        await resumeQueue(body.queueId);
      } else {
        await nextTrack(body.queueId);
      }
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
    const hybrid = require('./hybridOrchestrator');
    hybrid.stop(body.queueId);
    try {
      const { uri } = body;
      const queueId = await applyRedirect(body.queueId);
      if (queueId !== body.queueId) hybrid.stop(queueId);

      // Prime MA player volume to current speaker volume before starting AirPlay.
      // Without this, MA sends its stale remembered volume via AirPlay on session init,
      // causing the Bose to jump to a different level.
      if (body.volume != null) {
        await setPlayerVolume(queueId, body.volume).catch(e => console.warn('[ha/play] setPlayerVolume failed:', e.message));
      }

      const result = await playMedia(queueId, uri);
      // Store under both keys so /ha/station-uri works whether the caller knows
      // about the redirect or not (UI uses the speaker's own queue ID).
      activeStationUris[queueId] = uri;
      activeStationUris[body.queueId] = uri;
      if (uri && uri.startsWith('pandora://')) {
        pandoraTracker.setActiveStation(queueId, body.name || uri);
      }
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
      // elapsed_time is cumulative queue time across all tracks — NOT per-track position.
      // For Pandora: detect track changes and record the elapsed_time when each new track starts,
      // then compute per-track position as (elapsed_time - startElapsed).
      const isRadio = mediaType === 'radio' || provider === 'pandora';
      const trackKey = (meta?.title || item?.name || '') + '|' + (meta?.artist || '');
      let position = 0, positionUpdatedAt = null;
      if (isRadio && queueId) {
        const prev = pandoraPositionState[queueId];
        if (!prev || prev.trackKey !== trackKey) {
          // Prefer pandoraTracker's start position — it polls independently from server start
          // and catches the track earlier than the client's first poll. Its key is "artist|title"
          // vs our "title|artist", so flip to compare.
          const trackerState = pandoraTracker.getTrackState(queueId);
          const trackerKeyFlipped = (trackerState?.trackKey || '').split('|').reverse().join('|');
          const bestStart = (trackerKeyFlipped === trackKey && trackerState.queueElapsedAtStart != null)
            ? trackerState.queueElapsedAtStart
            : (queue?.elapsed_time || 0);
          pandoraPositionState[queueId] = { trackKey, startElapsed: bestStart };
        }
        const startElapsed = pandoraPositionState[queueId].startElapsed;
        position = Math.max(0, (queue?.elapsed_time || 0) - startElapsed);
        positionUpdatedAt = queue?.elapsed_time_last_updated || null;
      } else {
        position = queue?.elapsed_time || 0;
        positionUpdatedAt = queue?.elapsed_time_last_updated || null;
      }
      ok(res, {
        track:    meta?.title  || item?.name || null,
        artist:   meta?.artist || (item?.artists || item?.media_item?.artists || [])[0]?.name || null,
        album:    meta?.album  || item?.album?.name || item?.media_item?.album?.name || null,
        art:      meta?.image_url || item?.image?.path || item?.media_item?.image?.path || null,
        uri:      item?.media_item?.uri || null,
        duration: item?.duration || (isRadio ? (meta?.duration || 0) : 0),
        position,
        positionUpdatedAt,
        mediaType,
        stationName,
        provider,
        isRadio,
      });
    } catch (e) { err(res, e.message); }
    return;
  }

  // POST /ha/pandora-playlists — overwrite playlist data (used for backfill/restore)
  if (url === '/ha/pandora-playlists' && req.method === 'POST') {
    const body = await readBody(req);
    pandoraTracker.saveData(body);
    ok(res, { written: Object.keys(body).length });
    return;
  }

  // GET /ha/pandora-playlists — return all Pandora→Apple Music station playlists
  if (url === '/ha/pandora-playlists' && req.method === 'GET') {
    const data = pandoraTracker.loadData();
    const playlists = Object.entries(data).map(([station, v]) => ({
      station,
      trackCount: v.tracks.length,
      maPlaylistId: v.maPlaylistId || null,
      tracks: v.tracks || [],
    }));
    ok(res, { playlists });
    return;
  }

  // POST /ha/pandora-play-playlist — play a Pandora station playlist shuffled { stationName, queueId }
  if (url === '/ha/pandora-play-playlist' && req.method === 'POST') {
    const body = await readBody(req);
    const { stationName } = body;
    const data = pandoraTracker.loadData();
    const station = data[stationName];
    if (!station || !station.tracks.length) {
      err(res, 'No tracks collected for station: ' + stationName);
      return;
    }
    try {
      const queueId = await applyRedirect(body.queueId);
      if (station.maPlaylistId) {
        // Play the MA playlist directly (shuffle is handled by MA)
        await playMedia(queueId, `library://playlist/${station.maPlaylistId}`);
        try { await maPost('player_queues/shuffle', { queue_id: queueId, shuffle: true }); } catch {}
      } else {
        // Fallback: shuffle tracks in Node.js and enqueue them one by one
        const tracks = [...station.tracks].filter(t => t.appleUri).sort(() => Math.random() - 0.5);
        if (!tracks.length) { err(res, 'No Apple Music tracks found for station: ' + stationName); return; }
        await playMedia(queueId, tracks[0].appleUri);
        for (let i = 1; i < tracks.length; i++) {
          await maPost('player_queues/play_media', { queue_id: queueId, media: tracks[i].appleUri, option: 'add' });
        }
      }
      ok(res, {});
    } catch (e) { err(res, e.message); }
    return;
  }

  // GET /ha/station-uri?queueId=... — return the station URI last played on a queue (for restart after group join)
  if (url.startsWith('/ha/station-uri') && req.method === 'GET') {
    const queueId = new URL('http://x' + url).searchParams.get('queueId');
    // Redirected speakers (Bedroom): playback lives on the redirect target queue
    const resolved = resolveQueueRedirect(queueId).queueId;
    let uri = activeStationUris[queueId] || activeStationUris[resolved] || null;
    // Fallback: read URI from the current queue item (survives server restarts)
    if (!uri) {
      try {
        const queues = await getAllQueues();
        const queue  = (queues || []).find(q => q.queue_id === resolved);
        const itemUri = queue?.current_item?.media_item?.uri || null;
        if (itemUri) uri = itemUri;
      } catch {}
    }
    ok(res, { uri });
    return;
  }

  // GET /ha/queue-tracks?queueId=... — return the MA queue track list (current + upcoming + history)
  if (url.startsWith('/ha/queue-tracks') && req.method === 'GET') {
    const queueId = new URL('http://x' + url).searchParams.get('queueId');
    if (!queueId) { err(res, 'queueId required'); return; }
    try {
      const [tracks, queues] = await Promise.all([
        maPost('player_queues/items', { queue_id: queueId, offset: 0, limit: 50 }),
        getAllQueues(),
      ]);
      const arr   = Array.isArray(tracks) ? tracks : [];
      const queue = Array.isArray(queues) ? queues.find(q => q.queue_id === queueId) : null;
      const currentItem = queue?.current_item || null;
      ok(res, { tracks: arr, currentUri: currentItem?.uri || null, currentName: currentItem?.name || null });
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

  // GET /ha/ma-players — return MA player state including group info (for debugging)
  if (url === '/ha/ma-players' && req.method === 'GET') {
    try {
      const players = await getAllPlayers();
      const cfg = getConfig();
      const nameToQueue = {};
      for (const [name, queueId] of Object.entries(cfg.speakerQueues || {})) nameToQueue[name] = queueId;
      const queueToName = Object.fromEntries(Object.entries(nameToQueue).map(([n, q]) => [q, n]));
      const summary = (Array.isArray(players) ? players : [])
        .filter(p => queueToName[p.player_id])
        .map(p => ({
          name: queueToName[p.player_id],
          player_id: p.player_id,
          state: p.state,
          synced_to: p.synced_to,
          synced_to_name: p.synced_to ? queueToName[p.synced_to] : null,
          can_group_with: (p.can_group_with || []).map(id => queueToName[id] || id),
          powered: p.powered,
        }));
      ok(res, { players: summary });
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
  // Uses MA players/cmd/group — correct command for live AirPlay late-join (ring buffer).
  if (url === '/ha/group-include' && req.method === 'POST') {
    const body = await readBody(req);
    const names = body.speakerNames || (body.speakerName ? [body.speakerName] : []);
    if (!body.masterName || names.length === 0) {
      err(res, 'masterName and speakerNames required');
      return;
    }
    try {
      const cfg = getConfig();
      const maPlayers = await getAllPlayers();

      // Build maps: queue/player_id ↔ speaker name
      const nameToQueue = {};
      const queueToName = {};
      for (const [name, queueId] of Object.entries(cfg.speakerQueues || {})) {
        nameToQueue[name] = queueId;
        queueToName[queueId] = name;
      }

      // Identify the true MA leader. If the configured leader is itself playing, trust it.
      // Only fall back to scanning for the first non-idle player when the configured leader
      // is idle — this prevents falsely "correcting" to another speaker (e.g. Sunroom) that
      // happens to be paused and appears earlier in the MA player list.
      let leaderPlayerId = nameToQueue[body.masterName];
      const configuredLeaderPlayer = (maPlayers || []).find(p => p.player_id === leaderPlayerId);
      if (!configuredLeaderPlayer || configuredLeaderPlayer.state === 'idle') {
        for (const player of (maPlayers || [])) {
          if (player.synced_to === null && player.state !== 'idle' && queueToName[player.player_id]) {
            if (player.player_id !== leaderPlayerId) {
              console.log('[ha/group-include] correcting leader: %s → %s', leaderPlayerId, player.player_id);
              leaderPlayerId = player.player_id;
            }
            break;
          }
        }
      }

      if (!leaderPlayerId) {
        err(res, `No MA player ID for leader: ${body.masterName}`);
        return;
      }

      // players/cmd/group adds a single player to the target's group. Works for Bose
      // (AirPlay ring-buffer late-join, no stop needed) and native-wiim-provider players
      // (wiim_uuid:* IDs — MA sets synced_to internally). Verified 2026-07.
      const results = [];
      for (const name of names) {
        let memberId = nameToQueue[name];
        // Speakers with a playRedirects entry (e.g. Bose-Bedroom → Belkin AirPlay adapter)
        // must group the redirect target, not the Bose itself (which has no AirPlay).
        const redirect = (cfg.playRedirects || []).find(r => r.speakerName === name && r.toQueue);
        if (redirect) memberId = redirect.toQueue;
        if (!memberId) {
          console.warn('[ha/group-include] no player ID for %s, skipping', name);
          continue;
        }
        console.log('[ha/group-include] cmd/group: %s → leader %s', memberId, leaderPlayerId);
        const r = await groupPlayer(memberId, leaderPlayerId);
        console.log('[ha/group-include] cmd/group result:', JSON.stringify(r).slice(0, 200));
        results.push({ name, memberId, result: r, method: 'group' });
      }
      ok(res, { status: 200, results });
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
  // players/cmd/ungroup works for Bose AND native-wiim-provider players (verified 2026-07).
  // Do NOT gate on can_group_with — MA empties it while a player is synced.
  if (url === '/ha/group-remove' && req.method === 'POST') {
    const body = await readBody(req);
    const cfg = getConfig();
    let playerId = cfg.speakerQueues?.[body.speakerName];
    const redirect = (cfg.playRedirects || []).find(r => r.speakerName === body.speakerName && r.toQueue);
    if (redirect) playerId = redirect.toQueue;
    if (!playerId) {
      err(res, `No MA player ID for: ${body.speakerName}`);
      return;
    }
    try {
      const result = await ungroupPlayer(playerId);
      console.log('[ha/group-remove] cmd/ungroup %s (%s) result: %j', body.speakerName, playerId, result);
      ok(res, { status: 200 });
    } catch (e) {
      console.error('[ha/group-remove] error:', e.message);
      err(res, e.message);
      return;
    }
    setTimeout(() => applyGroupSideEffects([body.speakerName]), 1500);
    return;
  }

  // GET /ha/group-state — return active MA speaker groups (see getActiveGroups)
  if (url === '/ha/group-state' && req.method === 'GET') {
    try {
      ok(res, { groups: await getActiveGroups() });
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

  // GET /ha/appletv-entities — list all HA entities with "apple" in id or friendly_name (debug)
  if (url === '/ha/appletv-entities' && req.method === 'GET') {
    try {
      const allStates = await haGet('/api/states');
      const matches = Array.isArray(allStates)
        ? allStates
            .filter(s => s.entity_id.toLowerCase().includes('apple') ||
                         (s.attributes?.friendly_name || '').toLowerCase().includes('apple'))
            .map(s => ({ entity_id: s.entity_id, state: s.state, friendly_name: s.attributes?.friendly_name }))
        : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(matches, null, 2));
    } catch (e) { err(res, e.message); }
    return;
  }

  // POST /ha/appletv-on — wake Apple TV via HA
  if (url === '/ha/appletv-on' && req.method === 'POST') {
    try {
      const remoteEntity = await wakeAppleTv();
      if (!remoteEntity) { ok(res, { ok: false, error: 'no appleTvEntity configured' }); return; }
      console.log('[appletv-on] remote:', remoteEntity);
      ok(res, { ok: true, remoteEntity });
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

  // GET /ha/queue-health — cross-reference MA playing queues against actual speaker state
  if (url === '/ha/queue-health' && req.method === 'GET') {
    const cfg = getConfig();
    if (!cfg.features?.queueHealthCheck) { ok(res, { enabled: false, ok: true, issues: [] }); return; }
    try {
      const { getAllPlayers } = require('./maClient');
      const boseSources = require('./boseWatcher').getSources();
      const [allQueues, allPlayers] = await Promise.all([getAllQueues(), getAllPlayers().catch(() => [])]);

      const speakerQueues  = cfg.speakerQueues  || {};
      const playRedirects  = cfg.playRedirects  || [];
      const queueToName    = Object.fromEntries(Object.entries(speakerQueues).map(([n, q]) => [q, n]));
      const playerById     = Object.fromEntries((allPlayers || []).map(p => [p.player_id, p]));
      const queueById      = Object.fromEntries((allQueues  || []).map(q => [q.queue_id, q]));

      const issues = [];

      const checkQueue = (queueId, label, expectedBoseSource, boseSpkName) => {
        const q = queueById[queueId];
        if (!q || q.state !== 'playing') return;

        if (expectedBoseSource && boseSpkName) {
          // Bose speaker check via cached hardware source
          const src = boseSources[boseSpkName];
          if (src && src !== expectedBoseSource) {
            issues.push({ speaker: label, issue: `MA playing but Bose on ${src} (not ${expectedBoseSource})`, queueId });
          }
          return;
        }

        // MA player state check (WiiM, Belkin, non-Bose)
        const player = playerById[queueId];
        if (player && player.state === 'idle') {
          issues.push({ speaker: label, issue: 'MA queue playing but player is idle', queueId });
        }
        if (player && player.powered === false) {
          issues.push({ speaker: label, issue: 'MA queue playing but player is powered off', queueId });
        }
      };

      for (const [name, queueId] of Object.entries(speakerQueues)) {
        if (name.startsWith('_')) continue;
        // Bose speakers: validate via cached hardware source
        if (name.startsWith('Bose-')) {
          const redirect = playRedirects.find(r => r.speakerName === name && r.boseSwitchInput?.source);
          const expected = redirect?.boseSwitchInput?.source || 'AIRPLAY';
          checkQueue(queueId, name, expected, name);
          // Also check redirect target queue (e.g. Belkin for Bose-Bedroom)
          if (redirect?.toQueue) {
            const rSrc = boseSources[name];
            if (rSrc && rSrc !== redirect.boseSwitchInput.source) {
              const rq = queueById[redirect.toQueue];
              if (rq?.state === 'playing') {
                issues.push({ speaker: `${name} (AirPlay adapter)`, issue: `MA playing but Bose on ${rSrc} (not ${redirect.boseSwitchInput.source})`, queueId: redirect.toQueue });
              }
            }
          }
        } else {
          // WiiM and other non-Bose: check MA player state
          checkQueue(queueId, name, null, null);
        }
      }

      // Debounce: report only issues that were also present last poll, so a single
      // transient reading (stale WS source, end-of-track STANDBY blip) doesn't flash the banner.
      const curKeys = new Set(issues.map(i => `${i.queueId}|${i.issue}`));
      const stable  = issues.filter(i => prevQueueHealthKeys.has(`${i.queueId}|${i.issue}`));
      prevQueueHealthKeys = curKeys;

      ok(res, { enabled: true, ok: stable.length === 0, issues: stable });
    } catch (e) { err(res, e.message); }
    return;
  }

  // GET /ha/hybrid-mode — return all active playlist album mode queues
  // POST /ha/hybrid-mode { queueId } — stop playlist album mode for a queue
  if (url === '/ha/hybrid-mode') {
    if (req.method === 'GET') {
      const hybrid = require('./hybridOrchestrator');
      const queues = hybrid.getAll();
      // Mirror redirected sessions under the speaker's own queue ID so the UI
      // (which only knows speakerQueues) sees album-mode state for e.g. Bedroom.
      for (const r of (getConfig().playRedirects || [])) {
        if (r.fromQueue && r.toQueue && queues[r.toQueue] && !queues[r.fromQueue]) {
          queues[r.fromQueue] = queues[r.toQueue];
        }
      }
      ok(res, { queues });
      return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const { queueId } = body;
      if (!queueId) { err(res, 'queueId required'); return; }
      const hybrid = require('./hybridOrchestrator');
      hybrid.stop(queueId);
      hybrid.stop(resolveQueueRedirect(queueId).queueId);
      ok(res, {});
      return;
    }
  }

  // GET /ha/find-album-for-track?title=...&artist= — probe whether an album exists (no playback)
  if (url.startsWith('/ha/find-album-for-track') && req.method === 'GET') {
    const params = new URL('http://x' + url).searchParams;
    const title  = params.get('title')  || '';
    const artist = params.get('artist') || '';
    const album  = params.get('album')  || '';
    console.log('[find-album] searching: "%s" by "%s" (album: "%s")', title, artist, album || 'unknown');
    try {
      const { findAlbumTracks } = require('./hybridOrchestrator');
      const result = await findAlbumTracks(title, artist, album, null);
      if (result) console.log('[find-album] found "%s" (%d tracks)', result.albumName, result.tracks.length);
      else console.log('[find-album] not found for "%s"', title);
      ok(res, result ? { found: true, albumName: result.albumName, trackCount: result.tracks.length } : { found: false });
    } catch (e) { err(res, e.message); }
    return;
  }

  // POST /ha/album-once { queueId, stationUri } — play Apple Music album for current Pandora track, then restart station
  if (url === '/ha/album-once' && req.method === 'POST') {
    const body = await readBody(req);
    const { stationUri, stationName } = body;
    if (!body.queueId || !stationUri) { err(res, 'queueId and stationUri required'); return; }
    try {
      // Resolve redirect first — the current Pandora track lives on the redirect queue
      const queueId = await applyRedirect(body.queueId);
      const hybrid = require('./hybridOrchestrator');
      const result = await hybrid.startAlbumOnce(queueId, stationUri, stationName);
      if (result.error) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: result.error })); return; }
      ok(res, result);
    } catch (e) { err(res, e.message); }
    return;
  }

  // POST /ha/play-playlist-album { stationName, queueId } — play a local playlist in album mode
  if (url === '/ha/play-playlist-album' && req.method === 'POST') {
    const body = await readBody(req);
    const { stationName } = body;
    if (!stationName || !body.queueId) { err(res, 'stationName and queueId required'); return; }
    const data = pandoraTracker.loadData();
    const station = data[stationName];
    if (!station || !station.tracks.length) {
      err(res, 'No tracks collected for station: ' + stationName);
      return;
    }
    const appleUriTracks = station.tracks.filter(t => t.appleUri);
    if (!appleUriTracks.length) {
      err(res, 'No Apple Music tracks available for station: ' + stationName);
      return;
    }
    const shuffled = [...appleUriTracks].sort(() => Math.random() - 0.5);
    try {
      const queueId = await applyRedirect(body.queueId);
      const hybrid = require('./hybridOrchestrator');
      const result = await hybrid.startPlaylist(queueId, shuffled, stationName);
      if (result.error) { err(res, result.error); return; }
      ok(res, {});
    } catch (e) { err(res, e.message); }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

module.exports = handleHa;
module.exports.getActiveGroups = getActiveGroups; // exported for tests
