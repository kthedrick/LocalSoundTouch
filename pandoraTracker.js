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
const DATA_DIR  = fs.existsSync('/data') ? '/data' : __dirname;
const DATA_FILE = path.join(DATA_DIR, 'pandoraPlaylists.json');

// queueId → { trackKey, stationName, artist, title, album, trackDuration, queueElapsedAtStart, lastQueueElapsed }
const trackState = {};
const seenQueues = new Set();

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

async function addToPlaylist(maPost, stationName, artist, title, album) {
  if (!artist && !title) return;

  const data    = loadData();
  const station = data[stationName] || { maPlaylistId: null, tracks: [] };

  // Migrate from old maPlaylistUri field
  if (!('maPlaylistId' in station)) station.maPlaylistId = null;

  // Dedup by artist+title (case-insensitive)
  const key = (artist + '|' + title).toLowerCase().trim();
  if (station.tracks.some(t => (t.artist + '|' + t.title).toLowerCase().trim() === key)) {
    console.log('[pandoraTracker] already collected "%s - %s"', artist, title);
    return;
  }

  // Search Apple Music for matching track
  const result = await maPost('music/search', {
    search_query: (artist ? artist + ' ' : '') + title,
    media_types: ['track'],
    limit: 5,
  });
  const appleTrack = (result?.tracks || []).find(t =>
    (t.provider_mappings || []).some(m => m.provider_domain === 'apple_music')
  );
  if (!appleTrack) {
    console.log('[pandoraTracker] not found in Apple Music: "%s - %s"', artist, title);
    return;
  }
  const appleUri = appleTrack.uri;

  // Look up MA playlist by station name (null = not yet looked up, false = looked up, not found)
  if (station.maPlaylistId === null) {
    const id = await findMAPlaylistId(maPost, stationName);
    station.maPlaylistId = id || false;
    if (id) {
      console.log('[pandoraTracker] found MA playlist "%s" → id=%s', stationName, id);
    } else {
      console.log('[pandoraTracker] no MA playlist named "%s" — create one in the MA UI to enable sync', stationName);
    }
  }

  // Add track to MA playlist
  if (station.maPlaylistId) {
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

  // Always persist in JSON (used for UI + shuffle fallback playback)
  station.tracks.push({ artist, title, album: album || '', appleUri, addedAt: new Date().toISOString() });
  data[stationName] = station;
  saveData(data);
  console.log('[pandoraTracker] added "%s - %s" to "%s" (%d tracks)',
    artist, title, stationName, station.tracks.length);
}

function start(getAllQueues, maPost) {
  setInterval(async () => {
    try {
      const queues = await getAllQueues();
      if (!Array.isArray(queues)) return;

      for (const queue of queues) {
        const item = queue.current_item;
        if (!item) continue;

        const sd = item.streamdetails || {};
        const isPandora = sd.provider === 'pandora';
        if (!isPandora) continue;

        // Only collect while the queue is actively playing
        if (queue.state !== 'playing') continue;

        const queueId     = queue.queue_id;
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
          console.log('[pandoraTracker] detected Pandora on queue=%s station="%s"', queueId, stationName);
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
            console.log(`[pandoraTracker] completed "${prev.artist} - ${prev.title}" (${Math.round(timeSpent)}s of ${prev.trackDuration}s) → adding to "${prev.stationName}"`);
            addToPlaylist(maPost, prev.stationName, prev.artist, prev.title, prev.album).catch(e =>
              console.warn('[pandoraTracker] addToPlaylist error:', e.message)
            );
          } else {
            console.log(`[pandoraTracker] skipped "${prev.artist} - ${prev.title}" (${Math.round(timeSpent)}s of ${prev.trackDuration}s)`);
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

module.exports = { start, setActiveStation, loadData, saveData };
