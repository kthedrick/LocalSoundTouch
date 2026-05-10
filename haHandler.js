// HTTP handler for /ha/* routes — Music Assistant integration

const http = require('http');
const { stopQueue, clearQueue, getAllPlayers, groupPlayer, ungroupPlayer, setMembers, pauseQueue, resumeQueue, nextTrack, prevTrack, getAllQueues, playMedia, getConfig } = require('./maClient');

// Track the station URI most recently played on each queue (for stop→rejoin→restart)
const activeStationUris = {};

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
      activeStationUris[queueId] = uri;
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

  // GET /ha/station-uri?queueId=... — return the station URI last played on a queue (for restart after group join)
  if (url.startsWith('/ha/station-uri') && req.method === 'GET') {
    const queueId = new URL('http://x' + url).searchParams.get('queueId');
    ok(res, { uri: activeStationUris[queueId] || null });
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

      // Find the true MA leader: the non-idle player with synced_to=null that belongs to
      // a known speaker. HA entity state is unreliable when multiple members show identical
      // group_members lists — use MA's synced_to field instead.
      let leaderPlayerId = nameToQueue[body.masterName];
      for (const player of (maPlayers || [])) {
        if (player.synced_to === null && player.state !== 'idle' && queueToName[player.player_id]) {
          if (player.player_id !== leaderPlayerId) {
            console.log('[ha/group-include] correcting leader: %s → %s', leaderPlayerId, player.player_id);
            leaderPlayerId = player.player_id;
          }
          break;
        }
      }

      if (!leaderPlayerId) {
        err(res, `No MA player ID for leader: ${body.masterName}`);
        return;
      }

      // players/cmd/group adds a single player to the target's AirPlay group.
      // MA's AirPlay provider supports late-join via ring buffer — no stop needed.
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
        results.push({ name, memberId, result: r });
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
  // Uses MA players/cmd/ungroup directly (mirrors how group-include uses players/cmd/group).
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

  // GET /ha/group-state — return active MA speaker groups
  // Primary: MA players/all synced_to field (updates immediately after players/cmd/group).
  // Supplementary: HA entity group_members (catches WiiM and other non-speakerQueues speakers).
  if (url === '/ha/group-state' && req.method === 'GET') {
    try {
      const cfg = getConfig();
      const entityMap = cfg.speakerEntities || {};
      const reverseMap = {};
      for (const [name, entityId] of Object.entries(entityMap)) reverseMap[entityId] = name;

      // Build name↔queue maps for MA player lookup
      const nameToQueue = {};
      const queueToName = {};
      for (const [name, queueId] of Object.entries(cfg.speakerQueues || {})) {
        nameToQueue[name] = queueId;
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

      ok(res, { groups: filtered });
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
      const cfg = getConfig();
      const mediaEntity = cfg.tvConfig?.appleTvEntity;
      if (!mediaEntity) { ok(res, { ok: false, error: 'no appleTvEntity configured' }); return; }
      const remoteEntity = cfg.tvConfig?.appleTvRemoteEntity || mediaEntity.replace(/^media_player\./, 'remote.');
      console.log('[appletv-on] media:', mediaEntity, 'remote:', remoteEntity);
      await haServicePost('/api/services/remote/turn_on', { entity_id: remoteEntity });
      await new Promise(r => setTimeout(r, 500));
      await haServicePost('/api/services/remote/send_command', { entity_id: remoteEntity, command: 'home' });
      ok(res, { ok: true, mediaEntity, remoteEntity });
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
