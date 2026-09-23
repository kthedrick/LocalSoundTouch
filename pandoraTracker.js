// Pandora → Apple Music playlist builder
// Polls all MA queues every 5s; auto-detects Pandora streams by provider field.
// Tracks played ≥70% through are searched in Apple Music and added to a per-station playlist.
// Skipped/stopped tracks are ignored.
//
// MA playlist sync: create a playlist in the MA UI with the exact station name (e.g. "Radiohead Radio").
// The tracker will find it by name and add tracks automatically via music/playlists/add_playlist_tracks.
//
// Notes on MA queue data:
//   - current_item.duration is null for Pandora radio; real duration is in streamdetails.stream_metadata.duration
//   - queue.elapsed_time is cumulative queue time (not position within current track)
//   → We record queue.elapsed_time when a track first appears, then compute time_spent on change

const fs   = require('fs');
const path = require('path');

// Use /data (HA add-on persistent storage) when available, fall back to __dirname for local dev
const DATA_DIR  = process.env.LST_DATA_DIR || (fs.existsSync('/data') ? '/data' : __dirname);
const DATA_FILE = path.join(DATA_DIR, 'pandoraPlaylists.json');

// queueId → { trackKey, stationName, artist, title, album, trackDuration, queueElapsedAtStart, lastQueueElapsed }
const trackState = {};
const seenQueues = new Set();

// stationName → timestamp of last failed MA playlist lookup. In-memory only, so a
// lookup that failed (no playlist yet / transient error) retries hourly and always
// after a server restart — a playlist created later in the MA UI gets picked up.
const playlistLookupFailedAt = {};
const LOOKUP_RETRY_MS = 60 * 60 * 1000;

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}

function saveData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

// Look up an MA playlist by station name. Returns the numeric db_playlist_id string (e.g. "26"), or null.
// Tries exact match first, then strips trailing " Radio" (e.g. "Radiohead Radio" → "Radiohead").
async function findMAPlaylistId(maPost, stationName) {
  const candidates = [stationName, stationName.replace(/\s+Radio$/i, '')].filter(Boolean);
  try {
    const result = await maPost('music/search', {
      search_query: stationName,
      media_types: ['playlist'],
      limit: 20,
    });
    const playlists = result?.playlists || [];
    for (const name of candidates) {
      const match = playlists.find(p => (p.name || '').toLowerCase() === name.toLowerCase());
      if (match?.uri) return match.uri.split('/').pop();  // library://playlist/26 → "26"
    }
  } catch (e) {
    console.warn('[pandoraTracker] playlist lookup error:', e.message);
  }
  return null;
}

// Strip Pandora's parenthetical/bracketed suffixes (e.g. "(Remastered 1999/Rudy Van Gelder
// Edition)", "(feat. Joe Lovano)") that make Apple Music search return zero results.
function cleanForSearch(s) {
  return (s || '').replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function searchAppleForQuery(maPost, query) {
  const result = await maPost('music/search', { search_query: query, media_types: ['track'], limit: 5 });
  return (result?.tracks || []).find(t =>
    (t.provider_mappings || []).some(m => m.provider_domain === 'apple_music')
  ) || null;
}

// Search Apple Music for a matching track. Returns { appleUri, appleAlbum } or null.
async function searchAppleTrack(maPost, artist, title, album) {
  let appleTrack = await searchAppleForQuery(maPost, (artist ? artist + ' ' : '') + title);
  if (!appleTrack) {
    // Retry with parentheticals stripped — Pandora titles often carry remaster/feat. suffixes
    // that Apple Music's search doesn't match against.
    const cleanTitle = cleanForSearch(title);
    if (cleanTitle && cleanTitle !== title) {
      appleTrack = await searchAppleForQuery(maPost, (artist ? artist + ' ' : '') + cleanTitle);
    }
  }
  if (!appleTrack) return null;

  const appleUri = appleTrack.uri;
  let appleAlbum = appleTrack.album?.name || appleTrack.media_item?.album?.name || '';

  // Track search often returns album: null for singles. Do full S1/S2/S2b resolution as fallback
  // so the playlist entry has a confirmed album name for faster hybrid album lookups later.
  if (!appleAlbum) {
    try {
      const { findAlbumTracks } = require('./hybridOrchestrator');
      const found = await findAlbumTracks(title, artist, album || '', appleUri);
      if (found) appleAlbum = found.albumName;
    } catch (e) {
      console.warn('[pandoraTracker] album fallback search error:', e.message);
    }
  }
  return { appleUri, appleAlbum };
}

// Resolve the MA playlist id for a station (lazy, with hourly retry cooldown). Mutates station.
async function ensurePlaylistId(maPost, station, stationName) {
  if (station.maPlaylistId) return;
  // null/false = not found yet — retry with an hourly cooldown (never store a permanent
  // "not found": the user may create the playlist in the MA UI later, and transient
  // search errors must not stick).
  const lastFail = playlistLookupFailedAt[stationName] || 0;
  if (Date.now() - lastFail <= LOOKUP_RETRY_MS) return;
  const id = await findMAPlaylistId(maPost, stationName);
  if (id) {
    station.maPlaylistId = id;
    delete playlistLookupFailedAt[stationName];
    console.log('[pandoraTracker] found MA playlist "%s" → id=%s', stationName, id);
  } else {
    playlistLookupFailedAt[stationName] = Date.now();
    console.log('[pandoraTracker] no MA playlist named "%s" — create one in the MA UI to enable sync (retry in 1h)', stationName);
  }
}

// Push one track's Apple Music URI to the station's MA playlist (no-op if no playlist/URI).
async function addTrackToMAPlaylist(maPost, station, appleUri) {
  if (!station.maPlaylistId || !appleUri) return;
  try {
    await maPost('music/playlists/add_playlist_tracks', {
      db_playlist_id: station.maPlaylistId,
      uris: [appleUri],
    });
    console.log('[pandoraTracker] synced to MA playlist id=%s', station.maPlaylistId);
  } catch (e) {
    console.warn('[pandoraTracker] add_playlist_tracks failed:', e.message);
  }
}

async function addToPlaylist(maPost, stationName, artist, title, album) {
  if (!artist && !title) return;

  const data    = loadData();
  const station = data[stationName] || { maPlaylistId: null, tracks: [] };

  // Migrate from old maPlaylistUri field
  if (!('maPlaylistId' in station)) station.maPlaylistId = null;

  // Dedup by artist+title (case-insensitive). A previously-persisted-but-unresolved
  // entry (appleUri null, e.g. collected while Apple Music was down) is NOT skipped —
  // we fall through and try to resolve it now.
  const key = (artist + '|' + title).toLowerCase().trim();
  const existing = station.tracks.find(t => (t.artist + '|' + t.title).toLowerCase().trim() === key);
  if (existing && existing.appleUri) {
    console.log('[pandoraTracker] already collected "%s - %s"', artist, title);
    return;
  }

  const match = await searchAppleTrack(maPost, artist, title, album);

  if (match) {
    await ensurePlaylistId(maPost, station, stationName);
    await addTrackToMAPlaylist(maPost, station, match.appleUri);
  }

  if (existing) {
    // Previously persisted without an Apple Music match — fill it in if we found it now.
    if (match) {
      existing.appleUri = match.appleUri;
      existing.album    = match.appleAlbum || existing.album || album || '';
      delete existing.needsResolve;
      data[stationName] = station;
      saveData(data);
      console.log('[pandoraTracker] resolved "%s - %s" in "%s"', artist, title, stationName);
    }
    return;
  }

  if (match) {
    station.tracks.push({ artist, title, album: match.appleAlbum || album || '', appleUri: match.appleUri, addedAt: new Date().toISOString() });
    data[stationName] = station;
    saveData(data);
    console.log('[pandoraTracker] added "%s - %s" to "%s" (%d tracks)',
      artist, title, stationName, station.tracks.length);
  } else {
    // Apple Music didn't find it (commonly: provider down / expired user token). Persist
    // anyway with appleUri:null so the play record isn't lost — resolveUnresolved() retries
    // it later once Apple Music is healthy again. Shuffle playback filters on appleUri, so
    // an unresolved entry is inert until it resolves.
    station.tracks.push({ artist, title, album: album || '', appleUri: null, needsResolve: true, addedAt: new Date().toISOString() });
    data[stationName] = station;
    saveData(data);
    console.log('[pandoraTracker] persisted UNRESOLVED "%s - %s" to "%s" (%d tracks) — will retry Apple Music',
      artist, title, stationName, station.tracks.length);
  }
}

// Retry Apple Music resolution for every persisted track missing an appleUri. Runs on a
// timer and can be invoked on demand. Fills in appleUri/album and syncs to the MA playlist.
let lastStillMissing = 0;
async function resolveUnresolved(maPost) {
  const data = loadData();
  let resolved = 0, stillMissing = 0;
  for (const [stationName, station] of Object.entries(data)) {
    const pending = (station.tracks || []).filter(t => !t.appleUri);
    for (const t of pending) {
      try {
        const match = await searchAppleTrack(maPost, t.artist, t.title, t.album);
        if (match) {
          t.appleUri = match.appleUri;
          t.album    = match.appleAlbum || t.album || '';
          delete t.needsResolve;
          await ensurePlaylistId(maPost, station, stationName);
          await addTrackToMAPlaylist(maPost, station, match.appleUri);
          resolved++;
          console.log('[pandoraTracker] resolved "%s - %s" in "%s"', t.artist, t.title, stationName);
        } else {
          stillMissing++;
        }
      } catch (e) {
        console.warn('[pandoraTracker] resolveUnresolved error for "%s - %s": %s', t.artist, t.title, e.message);
      }
    }
  }
  if (resolved) saveData(data);
  // Log only on progress or a changed backlog — an unchanged count every cycle is noise
  if (resolved || stillMissing !== lastStillMissing) console.log('[pandoraTracker] resolveUnresolved: %d resolved, %d still missing', resolved, stillMissing);
  lastStillMissing = stillMissing;
  return { resolved, stillMissing };
}

function start(getAllQueues, maPost) {
  // Retry Apple Music resolution for tracks collected while AM was down. First pass 60s
  // after boot (let MA settle), then every 30 min.
  setTimeout(() => resolveUnresolved(maPost).catch(e => console.warn('[pandoraTracker] resolveUnresolved error:', e.message)), 60 * 1000);
  setInterval(() => resolveUnresolved(maPost).catch(e => console.warn('[pandoraTracker] resolveUnresolved error:', e.message)), 30 * 60 * 1000);

  setInterval(async () => {
    try {
      const queues = await getAllQueues();
      if (!Array.isArray(queues)) return;

      const { getConfig } = require('./maClient');
      const speakerQueues = getConfig().speakerQueues || {};
      const queueToName = Object.fromEntries(Object.entries(speakerQueues).map(([n, q]) => [q, n]));

      for (const queue of queues) {
        const item = queue.current_item;
        if (!item) continue;

        const sd = item.streamdetails || {};
        const isPandora = sd.provider === 'pandora';
        if (!isPandora) continue;

        // Only collect while the queue is actively playing
        if (queue.state !== 'playing') continue;

        const queueId     = queue.queue_id;
        const speakerName = queueToName[queueId] || queue.display_name || queue.name || queueId;
        const sm          = sd.stream_metadata || {};
        const stationName = item.media_item?.name || item.name || 'Pandora';
        const artist      = sm.artist || (item.artists || [])[0]?.name || '';
        const title       = sm.title  || '';
        const album       = sm.album  || '';
        const trackKey    = artist + '|' + title;
        // duration comes from stream_metadata (item.duration is null for Pandora radio)
        const trackDuration  = sm.duration || sd.duration || 0;
        // elapsed_time is cumulative queue time, not position within current track
        const queueElapsed   = queue.elapsed_time || 0;

        if (!seenQueues.has(queueId)) {
          seenQueues.add(queueId);
          console.log('[pandoraTracker] detected Pandora on %s station="%s"', speakerName, stationName);
        }

        const prev = trackState[queueId];
        if (prev && trackKey !== prev.trackKey && prev.artist) {
          // Track changed — compute how long the previous track actually played
          const timeSpent = prev.lastQueueElapsed - prev.queueElapsedAtStart;
          // Completed if ≥70% of track duration observed, OR ≥60s observed (handles
          // the post-restart case where we joined mid-track and missed the beginning)
          const completed = prev.trackDuration > 0
            ? timeSpent / prev.trackDuration >= 0.70 || timeSpent >= 60
            : timeSpent >= 60;

          if (completed) {
            console.log(`[pandoraTracker] completed "${prev.artist} - ${prev.title}" on ${speakerName} (${Math.round(timeSpent)}s of ${prev.trackDuration}s) → adding to "${prev.stationName}"`);
            addToPlaylist(maPost, prev.stationName, prev.artist, prev.title, prev.album).catch(e =>
              console.warn('[pandoraTracker] addToPlaylist error:', e.message)
            );
          } else {
            console.log(`[pandoraTracker] skipped "${prev.artist} - ${prev.title}" on ${speakerName} (${Math.round(timeSpent)}s of ${prev.trackDuration}s)`);
          }
        }

        if (prev && trackKey === prev.trackKey) {
          // Same track — update elapsed but keep original start time
          trackState[queueId] = { ...prev, lastQueueElapsed: queueElapsed };
        } else {
          // New track — record the queue elapsed time at the moment it started
          trackState[queueId] = {
            trackKey, stationName, artist, title, album,
            trackDuration,
            queueElapsedAtStart: queueElapsed,
            lastQueueElapsed:    queueElapsed,
          };
        }
      }
    } catch (e) {
      console.warn('[pandoraTracker] poll error:', e.message);
    }
  }, 5000);
}

// Kept for compatibility — no longer required since polling auto-detects Pandora queues
function setActiveStation(queueId, stationName) {
  console.log('[pandoraTracker] setActiveStation queue=%s station="%s" (auto-detection active)', queueId, stationName);
}

// Return the current per-queue track state (used by hybridOrchestrator for accurate position)
function getTrackState(queueId) {
  return trackState[queueId] || null;
}

module.exports = { start, setActiveStation, loadData, saveData, getTrackState, addToPlaylist, resolveUnresolved };
