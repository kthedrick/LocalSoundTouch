// tvWatcher.js — watches the LG TV via HA and auto-switches releaseToTV speakers to
// the TV (PRODUCT/TV) input when the user starts watching. Two triggers:
//   1. LG powers on (off→on) — any source.
//   2. The Apple TV starts PLAYING while the TV is on and showing it — i.e. the user
//      hit play on a show. Keyed off the Apple TV player state (not the LG input
//      source), because the source is already "Apple TV" while browsing an app; only
//      the player going to `playing` marks the actual start of watching.
// Each trigger stops+clears the MA queue first so AirPlay can't re-grab the speaker.

const http = require('http');
const { getConfig } = require('./maClient');

let prev = { on: null, appleWatching: null };  // null = first poll (no transition yet)
let lastTvState = null;  // raw HA state, for logging availability changes

function haGet(path) {
  const cfg = getConfig();
  const haUrl = new URL(cfg.haUrl || 'http://homeassistant:8123');
  return new Promise(resolve => {
    const req = http.request({
      hostname: haUrl.hostname, port: parseInt(haUrl.port) || 8123,
      path, method: 'GET',
      headers: { Authorization: 'Bearer ' + cfg.haToken },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    // destroy(err) so the 'error' handler fires and the promise resolves null
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
    req.end();
  });
}

function switchToTV(ip) {
  const body = '<ContentItem source="PRODUCT" sourceAccount="TV" type="ad" location="" isPresetable="false"/>';
  return new Promise(resolve => {
    const req = http.request({
      hostname: ip, port: 8090, path: '/select', method: 'POST',
      headers: { 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(); });
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

// Decide whether a poll transition should switch the soundbar to TV input. Pure so it
// can be unit-tested. `prev`/`curr` = { on: bool|null, appleWatching: bool|null }.
// appleWatching = LG on AND showing Apple TV AND the Apple TV player is `playing`.
// Returns a human-readable reason string, or null for no action.
function switchReason(p, curr) {
  if (!curr.on) return null;                                   // TV off → nothing to do
  if (p.on === false) return 'LG TV turned on';               // off → on (any source)
  if (curr.appleWatching && p.appleWatching === false) return 'Apple TV playback started';  // hit play on a show
  return null;
}

// Stop+clear each releaseToTV speaker's MA queue, then select its TV input.
async function switchReleaseSpeakersToTV(cfg, getSpeakers, reason) {
  console.log('[tvWatcher] %s — switching soundbar(s) to TV input', reason);
  const { stopQueue, clearQueue } = require('./maClient');
  const hybrid   = require('./hybridOrchestrator');
  const speakers = getSpeakers();

  for (const name of (cfg.releaseToTV || [])) {
    const spk = speakers.find(s => s.name === name);
    if (!spk?.ip) { console.warn('[tvWatcher] no IP for', name); continue; }

    const queueId = cfg.speakerQueues?.[name];
    if (queueId) {
      hybrid.stop(queueId);
      await stopQueue(queueId).catch(() => {});
      await clearQueue(queueId).catch(() => {});
    }
    // Wait for the Bose to settle out of INVALID_SOURCE after the AirPlay drop
    await new Promise(r => setTimeout(r, parseInt(process.env.LST_TVINPUT_SETTLE_MS) || 3000));
    await switchToTV(spk.ip);
    console.log('[tvWatcher] %s → TV input', name);
  }
}

function start(getSpeakers) {
  setInterval(async () => {
    try {
      const cfg = getConfig();
      const tv = cfg.tvConfig || {};
      if (!tv.lgTvEntity) return;
      if (!cfg.features?.tvAutoSwitch) return;

      const state = await haGet('/api/states/' + tv.lgTvEntity);
      // No state string (HA starting, or entity deleted → {message:'Entity not found.'})
      // is unknown, not on — skip the poll so it can't fake an off→on transition.
      if (typeof state?.state !== 'string') return;

      // Log availability changes: an 'unavailable' LG entity (e.g. lost webOS pairing)
      // reads as off forever, silently disabling auto-switch.
      if ((state.state === 'unavailable') !== (lastTvState === 'unavailable')) {
        if (state.state === 'unavailable') console.warn('[tvWatcher] %s is unavailable in HA — auto-switch disabled until it returns (webOS pairing lost? re-add LG integration)', tv.lgTvEntity);
        else if (lastTvState !== null) console.log('[tvWatcher] %s available again (%s)', tv.lgTvEntity, state.state);
      }
      lastTvState = state.state;

      const isOn = state.state !== 'off' && state.state !== 'unavailable' && state.state !== 'unknown';
      const source = state.attributes?.source || '';

      // Only when the TV is on and showing the Apple TV, check whether it's actually
      // playing — that (not the input source) is the "started watching" signal.
      let appleWatching = false;
      if (isOn && tv.appleTvSource && source === tv.appleTvSource && tv.appleTvEntity) {
        const at = await haGet('/api/states/' + tv.appleTvEntity);
        appleWatching = at?.state === 'playing';
      }
      const curr = { on: isOn, appleWatching };

      const reason = switchReason(prev, curr);
      if (reason) await switchReleaseSpeakersToTV(cfg, getSpeakers, reason);

      prev = curr;
    } catch (e) {
      console.error('[tvWatcher] error:', e.message);
    }
  }, parseInt(process.env.LST_TVWATCH_POLL_MS) || 4000);
}

module.exports = { start, switchReason };
