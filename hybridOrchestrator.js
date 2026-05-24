// Playlist Album Mode orchestrator
//
// When activated while something is playing: watches the current track without interrupting it.
// When activated while nothing is playing: starts the first playlist track.
//
// After the watched track ends (detected by queue idle OR MA auto-advancing to next track),
// plays the full album for that track on Apple Music, then advances to the next playlist track.
//
// Phase state machine:
//   'track'    → watching a playlist track; pre-fetches album at 60s remaining
//   'fetching' → Apple Music album search in progress (poll paused)
//   'album'    → album playing; watches for queue idle to advance

const { getAllQueues, maPost, stopQueue, clearQueue } = require('./maClient');

const activeQueues = {};

// ── Shared album search ────────────────────────────────────────────────────────
// Returns { albumName, tracks: [{uri, ...}] } or null. Tries S1 (track→album),
// S2 (album name search), S2b (artist album search). Same logic as fetchAlbum.

// Artist matching with word-based fallback — handles classical music where composer name
// spelling differs (Fryderyk vs Frédéric Chopin) or performer is the album artist.
function artistMatches(aArtist, normalizedArtist, aName) {
  if (!normalizedArtist) return true;
  if (aArtist.includes(normalizedArtist) || normalizedArtist.includes(aArtist)) return true;
  const words = normalizedArtist.split(/\s+/).filter(w => w.length > 3);
  return words.some(w => aArtist.includes(w) || (aName || '').includes(w));
}

// Extract performer from classical Pandora album format: "Performer, Composer: Work"
// Returns performer name (e.g. "Vladimir Ashkenazy") or null.
function extractPerformer(albumName) {
  if (!albumName) return null;
  const commaIdx = albumName.indexOf(', ');
  if (commaIdx < 0) return null;
  const before = albumName.substring(0, commaIdx).trim();
  const after  = albumName.substring(commaIdx + 2);
  // "after" must contain a colon (Composer: Work format); "before" must look like a person name
  if (!after.includes(':') || !before.includes(' ')) return null;
  return before;
}

async function findAlbumTracks(trackTitle, trackArtist, trackAlbum, trackAppleUri) {
  const normalizedArtist = (trackArtist || '').toLowerCase().trim();
  let albumItemId = null, albumProviderDomain = 'apple_music', albumName = trackAlbum || '';

  // S1: find Apple Music track → get album from its metadata
  const trackSearch = await maPost('music/search', {
    search_query: [trackTitle, trackArtist].filter(Boolean).join(' '),
    media_types: ['track'], limit: 10,
  });
  const appleTrack = (trackSearch?.tracks || []).find(t => {
    const isApple = (t.provider_mappings || []).some(pm => (pm.provider_domain || '').startsWith('apple_music'));
    if (!isApple) return false;
    if (trackAppleUri && t.uri === trackAppleUri) return true;
    const nameMatch = (t.name || '').toLowerCase().trim() === (trackTitle || '').toLowerCase().trim();
    if (!nameMatch) return false;
    if (!normalizedArtist) return true;
    const tArtist = ((t.artists || [])[0]?.name || '').toLowerCase().trim();
    return tArtist.includes(normalizedArtist) || normalizedArtist.includes(tArtist);
  });
  if (appleTrack) {
    const albumField = appleTrack.album || appleTrack.media_item?.album;
    if (albumField?.item_id) {
      albumItemId = String(albumField.item_id);
      albumName   = albumField.name || albumName;
      albumProviderDomain = (appleTrack.provider_mappings || []).find(pm =>
        (pm.provider_domain || '').startsWith('apple_music'))?.provider_domain || 'apple_music';
    }
  }

  // Helper: try an album candidate, return its tracks if valid, else null
  const tryAlbum = async (album) => {
    if (!album.item_id || parseInt(album.item_id) <= 1) return null;
    const aName = (album.name || '').toLowerCase();
    if (aName.endsWith('- single') || aName.endsWith('- ep')) return null;
    const apDomain = (album.provider_mappings || []).find(pm =>
      (pm.provider_domain || '').startsWith('apple_music'))?.provider_domain || 'apple_music';
    const tracks = await maPost('music/albums/album_tracks', {
      item_id: String(album.item_id), provider_instance_id_or_domain: apDomain, in_library_only: false,
    });
    if (!Array.isArray(tracks) || !tracks.length) return null;
    return { tracks, apDomain };
  };

  const commitAlbum = (album, tracks, apDomain, strategy) => {
    albumItemId = String(album.item_id);
    albumName   = album.name;
    albumProviderDomain = apDomain;
    console.log('[hybrid] %s found album "%s" by "%s"', strategy, album.name, (album.artists||[{}])[0]?.name);
    return tracks;
  };

  let resolvedTracks = null;

  // S2p: performer search — runs FIRST when Pandora album name encodes the performer.
  // "Vladimir Ashkenazy, Chopin: The Piano Works" → search by "Vladimir Ashkenazy Fryderyk Chopin",
  // require performer's last name as Apple Music album artist, composer word in album name.
  const performer = extractPerformer(trackAlbum);
  if (!resolvedTracks && performer) {
    const perfNorm  = performer.toLowerCase();
    const perfLast  = perfNorm.split(' ').pop();
    const composerWords = normalizedArtist.split(/\s+/).filter(w => w.length > 3);
    const perfSearch = await maPost('music/search', {
      search_query: performer + (trackArtist ? ' ' + trackArtist : ''),
      media_types: ['album'], limit: 20,
    });
    for (const album of (perfSearch?.albums || [])) {
      const isApple = (album.provider_mappings || []).some(pm => (pm.provider_domain || '').startsWith('apple_music'));
      if (!isApple) continue;
      const aArtist = (album.artists?.[0]?.name || '').toLowerCase();
      const aName   = (album.name || '').toLowerCase();
      if (!aArtist.includes(perfLast)) continue;  // must be by this performer
      if (composerWords.length && !composerWords.some(w => aName.includes(w))) continue;
      const r = await tryAlbum(album);
      if (r) { resolvedTracks = commitAlbum(album, r.tracks, r.apDomain, 'S2p'); break; }
    }
  }

  // S2: album name + artist search
  if (!resolvedTracks && trackAlbum) {
    const normalizedAlbum = trackAlbum.toLowerCase().trim();
    const albumSearch = await maPost('music/search', {
      search_query: [trackAlbum, trackArtist].filter(Boolean).join(' '),
      media_types: ['album'], limit: 10,
    });
    for (const album of (albumSearch?.albums || [])) {
      const isApple = (album.provider_mappings || []).some(pm => (pm.provider_domain || '').startsWith('apple_music'));
      if (!isApple) continue;
      const aArtist = (album.artists?.[0]?.name || '').toLowerCase().trim();
      const aName   = (album.name || '').toLowerCase().trim();
      if (artistMatches(aArtist, normalizedArtist, aName) && normalizedAlbum && aName.includes(normalizedAlbum)) {
        const apDomain = (album.provider_mappings || []).find(pm =>
          (pm.provider_domain || '').startsWith('apple_music'))?.provider_domain || 'apple_music';
        albumItemId = String(album.item_id);
        albumName   = album.name;
        albumProviderDomain = apDomain;
        break;
      }
    }
  }

  // S2b: any proper album by the artist — validate tracks exist before committing
  if (!resolvedTracks && !albumItemId && normalizedArtist) {
    const artistSearch = await maPost('music/search', { search_query: trackArtist, media_types: ['album'], limit: 20 });
    for (const album of (artistSearch?.albums || [])) {
      const isApple = (album.provider_mappings || []).some(pm => (pm.provider_domain || '').startsWith('apple_music'));
      if (!isApple) continue;
      const aArtist = (album.artists?.[0]?.name || '').toLowerCase().trim();
      const aName   = (album.name || '').toLowerCase();
      if (!artistMatches(aArtist, normalizedArtist, aName)) continue;
      const r = await tryAlbum(album);
      if (r) { resolvedTracks = commitAlbum(album, r.tracks, r.apDomain, 'S2b'); break; }
    }
  }

  if (!resolvedTracks && !albumItemId) return null;

  const albumTracks = resolvedTracks || await maPost('music/albums/album_tracks', {
    item_id: albumItemId, provider_instance_id_or_domain: albumProviderDomain, in_library_only: false,
  });
  if (!Array.isArray(albumTracks) || !albumTracks.length) return null;

  const sorted = albumTracks.sort((a, b) => {
    if (a.disc_number !== b.disc_number) return (a.disc_number || 0) - (b.disc_number || 0);
    return (a.track_number || 0) - (b.track_number || 0);
  });
  const normalizedTitle = (trackTitle || '').toLowerCase().trim();
  const seedIdx = sorted.findIndex(t => (t.name || '').toLowerCase().trim() === normalizedTitle);
  const tracks = seedIdx === 0 ? sorted.slice(1) : sorted;
  if (!tracks.length) return null;

  return { albumName, tracks };
}

async function startPlaylist(queueId, tracks, stationName) {
  if (activeQueues[queueId]) stopPlaylist(queueId);
  if (!tracks.length) return { error: 'No tracks in playlist' };

  let trackTitle = '', trackArtist = '', trackAlbum = '', trackDuration = 0;
  let playlistIndex = 0, isCurrentlyPlaying = false;

  // Check if something is already playing — if so, watch it without interrupting
  try {
    const allQueues = await getAllQueues();
    const queue = (allQueues || []).find(q => q.queue_id === queueId);
    if (queue?.state === 'playing' && queue.current_item) {
      const item = queue.current_item;
      trackTitle    = item.name || '';
      trackArtist   = (item.artists || [])[0]?.name || '';
      trackAlbum    = item.album?.name || item.media_item?.album?.name || '';
      trackDuration = item.duration || 0;
      isCurrentlyPlaying = true;

      // Find this track in our playlist for better metadata + correct next-track index
      const matchIdx = tracks.findIndex(t =>
        t.appleUri === item.uri ||
        (t.title || '').toLowerCase().trim() === trackTitle.toLowerCase().trim()
      );
      if (matchIdx >= 0) {
        playlistIndex = matchIdx;
        trackTitle  = tracks[matchIdx].title  || trackTitle;
        trackArtist = tracks[matchIdx].artist || trackArtist;
        trackAlbum  = tracks[matchIdx].album  || trackAlbum;
      }
      console.log('[hybrid] album mode — watching current track "%s" without interrupting', trackTitle);
    }
  } catch (e) {
    console.warn('[hybrid] could not check current queue state:', e.message);
  }

  if (!isCurrentlyPlaying) {
    const track = tracks[0];
    try {
      // Stop and clear any existing Pandora/radio source before starting Apple Music playback.
      // Without this, MA keeps the radio as the underlying queue source and it bleeds back in.
      const { stopQueue, clearQueue } = require('./maClient');
      await stopQueue(queueId).catch(() => {});
      await clearQueue(queueId).catch(() => {});
      await maPost('player_queues/play_media', { queue_id: queueId, media: track.appleUri, option: 'play' });
    } catch (e) {
      return { error: 'Failed to start track: ' + e.message };
    }
    trackTitle  = track.title  || '';
    trackArtist = track.artist || '';
    trackAlbum  = track.album  || '';
    console.log('[hybrid] album mode — started first track "%s"', trackTitle);
  }

  activeQueues[queueId] = {
    stationName: stationName || '',
    playlistTracks: tracks,
    playlistIndex,
    phase: 'track',
    trackTitle, trackArtist, trackAlbum,
    trackDuration,
    wallClockAtStart: Date.now(),
    // watchedTrackKey: detect when MA naturally advances to the next track
    watchedTrackKey: trackTitle ? (trackTitle + '|' + trackArtist) : null,
    trackEndedDetected: false,
    albumFetchStarted: isCurrentlyPlaying,  // fetch immediately if already mid-track
    albumFetchDone: false,                  // true when fetch completed with no album found
    pendingAlbumTracks: null,
    pendingAlbumName: null,
    currentAlbumName: null,
    // guardUntil: suppress "track ended" detection until MA queue reflects the new track.
    // Set after play_media calls to prevent false positives during MA's loading delay (~5s).
    guardUntil: isCurrentlyPlaying ? 0 : Date.now() + 30000,
    pollTimer: null,
  };

  console.log('[hybrid] started queue=%s station="%s" %d tracks watching="%s"',
    queueId, stationName, tracks.length, trackTitle);
  schedulePoll(queueId);

  if (isCurrentlyPlaying) {
    // Don't know remaining time — pre-fetch the album now so it's ready when track ends
    fetchAlbum(queueId);
  }

  return { ok: true };
}

function stopPlaylist(queueId) {
  const s = activeQueues[queueId];
  if (!s) return;
  if (s.pollTimer) { clearTimeout(s.pollTimer); s.pollTimer = null; }
  delete activeQueues[queueId];
  console.log('[hybrid] stopped queue=%s', queueId);
}

function getAll() {
  return Object.fromEntries(
    Object.entries(activeQueues).map(([id, s]) => {
      // Upcoming albums: from current index forward (album phase = already on this album, so start +1)
      const startIdx = s.phase === 'album' ? s.playlistIndex + 1 : s.playlistIndex;
      const upcomingAlbums = [];
      for (let i = startIdx; i < Math.min(startIdx + 20, s.playlistTracks.length); i++) {
        const t = s.playlistTracks[i];
        upcomingAlbums.push({ artist: t.artist || '', album: t.album || '', title: t.title || '' });
      }
      return [id, {
        phase: s.phase,
        stationName: s.stationName,
        playlistIndex: s.playlistIndex,
        playlistTotal: s.playlistTracks.length,
        currentAlbumName: s.currentAlbumName || null,
        upcomingAlbums,
        restartUri:     s.restartUri     || null,
        restartStation: s.restartStation || null,
      }];
    })
  );
}

function schedulePoll(queueId) {
  const s = activeQueues[queueId];
  if (!s) return;
  s.pollTimer = setTimeout(async () => {
    if (!activeQueues[queueId]) return;
    try { await poll(queueId); } catch (e) { console.error('[hybrid] poll error:', e.message); }
    schedulePoll(queueId);
  }, 5000);
}

async function poll(queueId) {
  const s = activeQueues[queueId];
  if (!s || s.phase === 'fetching') return;

  const allQueues = await getAllQueues();
  const queue = (allQueues || []).find(q => q.queue_id === queueId);
  if (!queue) return;

  if (s.phase === 'track') {
    const item = queue.current_item;

    // Pick up duration from MA once it's available
    if (s.trackDuration === 0 && item?.duration) s.trackDuration = item.duration;

    // Pre-fetch album at 60s remaining (wall clock from when we started watching)
    if (s.trackDuration > 0 && !s.albumFetchStarted) {
      const inTrackElapsed = (Date.now() - s.wallClockAtStart) / 1000;
      const remaining = Math.max(0, s.trackDuration - inTrackElapsed);
      if (remaining > 0 && remaining <= 60) {
        s.albumFetchStarted = true;
        fetchAlbum(queueId);  // intentionally not awaited — sets phase='fetching' immediately
      }
    }

    // Detect track ended: queue is idle, OR MA auto-advanced to a different track
    const currentKey = item
      ? ((item.name || '') + '|' + ((item.artists || [])[0]?.name || ''))
      : null;

    // Pandora reports tracks as "Artist - Title" in the name field with an empty artist field.
    // The title may be shortened vs the Apple Music version (e.g. "Liz On Top of the World"
    // vs "Marianelli: Liz On Top Of The World (From "Pride & Prejudice" Soundtrack)").
    // Strip the "Artist - " prefix, then check if either title contains the other.
    const currentArtist = (item?.artists || [])[0]?.name || '';
    const watchedTitle  = (s.watchedTrackKey || '').split('|')[0];
    const pandoraStripped = !currentArtist
      ? (item?.name || '').replace(/^.+? - /, '').toLowerCase().trim()
      : '';
    const pandoraFormatOnly = !currentArtist && watchedTitle.length > 5 && pandoraStripped.length > 5 &&
      (watchedTitle.toLowerCase().includes(pandoraStripped) || pandoraStripped.includes(watchedTitle.toLowerCase()));

    const trackAdvanced = s.watchedTrackKey && currentKey && currentKey !== '|'
      && currentKey !== s.watchedTrackKey && !pandoraFormatOnly;
    const trackEnded = queue.state === 'idle' || trackAdvanced;

    // Suppress detection while MA is still loading the track we just queued.
    const guarded = Date.now() < (s.guardUntil || 0);

    if (trackEnded && !s.trackEndedDetected && !guarded) {
      s.trackEndedDetected = true;
      if (trackAdvanced) {
        console.log('[hybrid] track advanced from "%s" to "%s"', s.watchedTrackKey, currentKey);
      }
      if (s.pendingAlbumTracks?.length) {
        await playAlbum(queueId);
      } else if (s.albumFetchDone) {
        // Fetch already finished but found no album — advance to next playlist track
        await advanceToNextTrack(queueId);
      } else if (!s.albumFetchStarted) {
        // Track ended before pre-fetch window — start fetch now; it will play on completion
        s.albumFetchStarted = true;
        fetchAlbum(queueId);
      }
      // else: fetch in progress — fetchAlbum checks trackEndedDetected on completion
    }

  } else if (s.phase === 'album') {
    // Only advance when the queue is truly exhausted — both idle state AND no current item.
    // Checking just state can catch a transient idle while MA loads the first album track.
    if (queue.state === 'idle' && !queue.current_item) {
      if (s.restartUri) {
        // Album-once mode: restart the original Pandora station then stop watching
        console.log('[hybrid] album-once: album finished, restarting station');
        stopPlaylist(queueId);
        await maPost('player_queues/play_media', { queue_id: queueId, media: s.restartUri, option: 'play' });
      } else {
        await advanceToNextTrack(queueId);
      }
    }
  }
}

async function playAlbum(queueId) {
  const s = activeQueues[queueId];
  if (!s || !s.pendingAlbumTracks?.length) return;
  const tracks    = s.pendingAlbumTracks;
  const albumName = s.pendingAlbumName;
  s.pendingAlbumTracks = null;
  s.pendingAlbumName   = null;
  s.currentAlbumName   = albumName;
  s.phase = 'album';
  try {
    await maPost('player_queues/play_media', { queue_id: queueId, media: tracks[0].uri, option: 'play' });
    for (let i = 1; i < tracks.length; i++) {
      if (!activeQueues[queueId]) return;  // session stopped mid-queue — abort
      await maPost('player_queues/play_media', { queue_id: queueId, media: tracks[i].uri, option: 'add' });
    }
    console.log('[hybrid] album queued: "%s" (%d tracks)', albumName, tracks.length);
  } catch (e) {
    console.error('[hybrid] error queuing album:', e.message);
    await advanceToNextTrack(queueId);
  }
}

async function advanceToNextTrack(queueId) {
  const s = activeQueues[queueId];
  if (!s) return;

  let { playlistTracks, playlistIndex } = s;
  let nextIndex = playlistIndex + 1;
  if (nextIndex >= playlistTracks.length) {
    playlistTracks = [...playlistTracks].sort(() => Math.random() - 0.5);
    nextIndex = 0;
    s.playlistTracks = playlistTracks;
  }

  const next = playlistTracks[nextIndex];
  // Update non-poll-guarded fields synchronously so other code sees consistent playlist position.
  s.playlistIndex      = nextIndex;
  s.phase              = 'track';
  s.trackTitle         = next.title  || '';
  s.trackArtist        = next.artist || '';
  s.trackAlbum         = next.album  || '';
  s.trackDuration      = 0;
  s.wallClockAtStart   = Date.now();
  s.pendingAlbumTracks = null;
  s.pendingAlbumName   = null;
  s.currentAlbumName   = null;
  // Leave trackEndedDetected=true and watchedTrackKey at old value until after await.
  // This keeps the poll guard active during the HTTP call so a concurrent poll can't
  // re-fire "track ended" while MA is still loading the new track.

  try {
    const { stopQueue, clearQueue } = require('./maClient');
    await stopQueue(queueId).catch(() => {});
    await clearQueue(queueId).catch(() => {});
    await maPost('player_queues/play_media', { queue_id: queueId, media: next.appleUri, option: 'play' });
    console.log('[hybrid] next track [%d/%d]: "%s - %s"',
      nextIndex + 1, playlistTracks.length, next.artist, next.title);
  } catch (e) {
    console.error('[hybrid] failed to play next track:', e.message);
  }

  // Reset detection guards only after play_media completes. The 12s grace window
  // prevents false "track ended" during MA's queue-state loading delay.
  s.watchedTrackKey    = next.title ? (next.title + '|' + (next.artist || '')) : null;
  s.trackEndedDetected = false;
  s.albumFetchStarted  = false;
  s.albumFetchDone     = false;
  s.guardUntil         = Date.now() + 30000;
}

async function fetchAlbum(queueId) {
  const s = activeQueues[queueId];
  if (!s || s.phase !== 'track') return;
  s.phase = 'fetching';

  const { trackTitle, trackArtist, trackAlbum, playlistTracks, playlistIndex } = s;
  const trackAppleUri = playlistTracks[playlistIndex]?.appleUri || null;
  console.log('[hybrid] pre-fetching album for "%s" by "%s"', trackTitle, trackArtist);

  try {
    let albumItemId = null, albumProviderDomain = 'apple_music', albumName = trackAlbum;

    const normalizedArtist = (trackArtist || '').toLowerCase().trim();

    // Strategy 1: search for the exact Apple Music track → get album from track's own metadata.
    // URI match is authoritative. Name match requires the artist to also match.
    const trackSearch = await maPost('music/search', {
      search_query: [trackTitle, trackArtist].filter(Boolean).join(' '),
      media_types: ['track'], limit: 10,
    });
    const appleTrack = (trackSearch?.tracks || []).find(t => {
      const isApple = (t.provider_mappings || []).some(pm => (pm.provider_domain || '').startsWith('apple_music'));
      if (!isApple) return false;
      // Exact URI match — fully trusted
      if (trackAppleUri && t.uri === trackAppleUri) return true;
      // Name match: require artist to also match to avoid wrong versions
      const nameMatch = (t.name || '').toLowerCase().trim() === (trackTitle || '').toLowerCase().trim();
      if (!nameMatch) return false;
      if (!normalizedArtist) return true;
      const tArtist = ((t.artists || [])[0]?.name || '').toLowerCase().trim();
      return tArtist.includes(normalizedArtist) || normalizedArtist.includes(tArtist);
    });
    if (appleTrack) {
      const albumField = appleTrack.album || appleTrack.media_item?.album;
      if (albumField?.item_id) {
        albumItemId = String(albumField.item_id);
        albumName   = albumField.name || albumName;
        albumProviderDomain = (appleTrack.provider_mappings || []).find(pm =>
          (pm.provider_domain || '').startsWith('apple_music')
        )?.provider_domain || 'apple_music';
        console.log('[hybrid] S1 found track → album "%s" id=%s', albumName, albumItemId);
      }
    }

    // Strategy 2: album name + artist search — requires BOTH artist AND name match, no fallback.
    if (!albumItemId && trackAlbum) {
      const normalizedAlbum = (trackAlbum || '').toLowerCase().trim();
      const albumSearch = await maPost('music/search', {
        search_query: [trackAlbum, trackArtist].filter(Boolean).join(' '),
        media_types: ['album'], limit: 10,
      });
      for (const album of (albumSearch?.albums || [])) {
        const isApple = (album.provider_mappings || []).some(pm => (pm.provider_domain || '').startsWith('apple_music'));
        if (!isApple) continue;
        const aArtist = (album.artists?.[0]?.name || '').toLowerCase().trim();
        const aName   = (album.name || '').toLowerCase().trim();
        const artistMatch = normalizedArtist && (aArtist.includes(normalizedArtist) || normalizedArtist.includes(aArtist));
        const nameMatch   = normalizedAlbum  && aName.includes(normalizedAlbum);
        if (artistMatch && nameMatch) {
          albumItemId = String(album.item_id);
          albumName   = album.name;
          albumProviderDomain = (album.provider_mappings || []).find(pm =>
            (pm.provider_domain || '').startsWith('apple_music')
          )?.provider_domain || 'apple_music';
          console.log('[hybrid] S2 found album "%s" id=%s', albumName, albumItemId);
          break;
        }
      }
      if (albumItemId) console.log('[hybrid] album "%s" id=%s via name search', albumName, albumItemId);
    }

    // Strategy 2b: artist-only album search — last resort when track has no album metadata.
    // Finds a proper (non-single) album by the same artist. Not track-specific but far better
    // than "no album found" for artists like 2CELLOS where MA returns the single version.
    if (!albumItemId && normalizedArtist) {
      const artistSearch = await maPost('music/search', {
        search_query: trackArtist,
        media_types: ['album'], limit: 20,
      });
      for (const album of (artistSearch?.albums || [])) {
        const isApple = (album.provider_mappings || []).some(pm => (pm.provider_domain || '').startsWith('apple_music'));
        if (!isApple) continue;
        const aArtist = (album.artists?.[0]?.name || '').toLowerCase().trim();
        if (!artistMatches(aArtist, normalizedArtist, aName)) continue;
        const aName = (album.name || '').toLowerCase();
        if (aName.endsWith('- single') || aName.endsWith('- ep')) continue;
        albumItemId = String(album.item_id);
        albumName   = album.name;
        albumProviderDomain = (album.provider_mappings || []).find(pm =>
          (pm.provider_domain || '').startsWith('apple_music')
        )?.provider_domain || 'apple_music';
        console.log('[hybrid] S2b found artist album "%s" id=%s', albumName, albumItemId);
        break;
      }
    }

    const noAlbum = async (reason) => {
      console.log('[hybrid] %s for "%s" by "%s" — skipping album', reason, trackTitle, trackArtist);
      if (activeQueues[queueId] !== s) return;
      s.albumFetchDone = true;
      s.phase = 'track';
      if (s.trackEndedDetected) await advanceToNextTrack(queueId);
    };

    if (!albumItemId) { await noAlbum('no album found'); return; }

    const albumTracks = await maPost('music/albums/album_tracks', {
      item_id: albumItemId,
      provider_instance_id_or_domain: albumProviderDomain,
      in_library_only: false,
    });

    if (!Array.isArray(albumTracks) || !albumTracks.length) { await noAlbum('no tracks for album id=' + albumItemId); return; }

    const sorted = albumTracks.sort((a, b) => {
      if (a.disc_number !== b.disc_number) return (a.disc_number || 0) - (b.disc_number || 0);
      return (a.track_number || 0) - (b.track_number || 0);
    });

    // If seed track is track 1: start from track 2 to avoid replaying it.
    // If seed is a deeper cut: play the whole album (it's ok if seed repeats later).
    const normalizedTitle = (trackTitle || '').toLowerCase().trim();
    const seedIdx = sorted.findIndex(t => (t.name || '').toLowerCase().trim() === normalizedTitle);
    const tracksToPlay = seedIdx === 0 ? sorted.slice(1) : sorted;

    if (!tracksToPlay.length) { await noAlbum('all tracks filtered'); return; }
    if (activeQueues[queueId] !== s) return;

    s.pendingAlbumTracks = tracksToPlay;
    s.pendingAlbumName   = albumName;
    s.phase = 'track';
    console.log('[hybrid] album "%s" ready (%d tracks)', albumName, tracksToPlay.length);

    // If the track already ended while we were fetching, play the album immediately.
    // Check both the flag (set by poll) and a fresh queue state (in case poll was in 'fetching' skip the whole time).
    const freshQueues = await getAllQueues();
    const freshQueue  = (freshQueues || []).find(q => q.queue_id === queueId);
    const freshItem   = freshQueue?.current_item;
    const freshKey       = freshItem ? ((freshItem.name || '') + '|' + ((freshItem.artists || [])[0]?.name || '')) : null;
    const freshArtist    = (freshItem?.artists || [])[0]?.name || '';
    const freshStripped  = !freshArtist ? (freshItem?.name || '').replace(/^.+? - /, '').toLowerCase().trim() : '';
    const freshPandoraFormatOnly = !freshArtist && (trackTitle || '').length > 5 && freshStripped.length > 5 &&
      ((trackTitle || '').toLowerCase().includes(freshStripped) || freshStripped.includes((trackTitle || '').toLowerCase()));
    const alreadyEnded = s.trackEndedDetected
      || freshQueue?.state === 'idle'
      || (s.watchedTrackKey && freshKey && freshKey !== '|' && freshKey !== s.watchedTrackKey && !freshPandoraFormatOnly);
    if (alreadyEnded && activeQueues[queueId] === s && s.pendingAlbumTracks?.length) {
      s.trackEndedDetected = true;
      await playAlbum(queueId);
    }
  } catch (e) {
    console.error('[hybrid] fetchAlbum error:', e.message);
    if (activeQueues[queueId] === s) {
      s.albumFetchDone = true;
      s.phase = 'track';
      if (s.trackEndedDetected) await advanceToNextTrack(queueId);
    }
  }
}

// ── Album-once mode ───────────────────────────────────────────────────────────
// Play the full Apple Music album for the currently-playing Pandora track,
// then restart the Pandora station when done. Does nothing if no album found.
async function startAlbumOnce(queueId, stationUri, stationName) {
  if (activeQueues[queueId]) stopPlaylist(queueId);

  // Read current Pandora track
  const allQueues = await getAllQueues();
  const queue = (allQueues || []).find(q => q.queue_id === queueId);
  if (!queue?.current_item) return { error: 'Nothing playing' };

  const item = queue.current_item;
  const sm   = item.streamdetails?.stream_metadata || {};
  let trackTitle  = sm.title  || '';
  let trackArtist = sm.artist || (item.artists || [])[0]?.name || '';

  // Pandora puts "Artist - Title" in item.name with empty artist/title fields
  if (!trackTitle) {
    const name = item.name || '';
    const dash = name.indexOf(' - ');
    if (dash > 0 && !trackArtist) {
      trackArtist = name.substring(0, dash).trim();
      trackTitle  = name.substring(dash + 3).trim();
    } else {
      trackTitle = name;
    }
  }

  if (!trackTitle && !trackArtist) return { error: 'Could not identify current track' };

  console.log('[hybrid] album-once: searching album for "%s" by "%s"', trackTitle, trackArtist);
  const found = await findAlbumTracks(trackTitle, trackArtist, sm.album || '', null);
  if (!found) {
    console.log('[hybrid] album-once: no album found — leaving Pandora running');
    return { error: `No album found for "${trackArtist ? trackArtist + ' - ' : ''}${trackTitle}"` };
  }

  const { albumName, tracks } = found;
  console.log('[hybrid] album-once: found "%s" (%d tracks) — stopping Pandora', albumName, tracks.length);

  // Stop Pandora, wait for Bose to settle, then play album
  await stopQueue(queueId).catch(() => {});
  await clearQueue(queueId).catch(() => {});
  await maPost('player_queues/play_media', { queue_id: queueId, media: tracks[0].uri, option: 'play' });
  for (let i = 1; i < tracks.length; i++) {
    await maPost('player_queues/play_media', { queue_id: queueId, media: tracks[i].uri, option: 'add' });
  }
  console.log('[hybrid] album-once: "%s" queued (%d tracks), will restart station after', albumName, tracks.length);

  activeQueues[queueId] = {
    stationName: albumName, playlistTracks: [], playlistIndex: 0,
    phase: 'album', trackTitle, trackArtist, trackAlbum: albumName, trackDuration: 0,
    wallClockAtStart: Date.now(), watchedTrackKey: null,
    trackEndedDetected: false, albumFetchStarted: true, albumFetchDone: false,
    pendingAlbumTracks: null, pendingAlbumName: null, currentAlbumName: albumName,
    guardUntil: 0, restartUri: stationUri, restartStation: stationName || '', pollTimer: null,
  };
  schedulePoll(queueId);
  return { ok: true, albumName, trackCount: tracks.length };
}

module.exports = { startPlaylist, startAlbumOnce, stop: stopPlaylist, getAll, findAlbumTracks };
