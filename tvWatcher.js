// tvWatcher.js — watches LG TV via HA, auto-switches releaseToTV speakers to TV input on power-on

const http = require('http');
const { getConfig } = require('./maClient');

let prevTvState = null;  // 'on' | 'off' | null — null = first poll (no transition)

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

function start(getSpeakers) {
  setInterval(async () => {
    try {
      const cfg = getConfig();
      const tv = cfg.tvConfig || {};
      if (!tv.lgTvEntity) return;
      if (!cfg.features?.tvAutoSwitch) return;

      const state = await haGet('/api/states/' + tv.lgTvEntity);
      if (!state) return;

      const isOn = state.state !== 'off' && state.state !== 'unavailable' && state.state !== 'unknown';
      const cur  = isOn ? 'on' : 'off';

      if (prevTvState === 'off' && cur === 'on') {
        console.log('[tvWatcher] LG TV turned on — auto-switching soundbar to TV input');
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
          // Wait for Bose to settle out of INVALID_SOURCE after AirPlay drop
          await new Promise(r => setTimeout(r, 3000));
          await switchToTV(spk.ip);
          console.log('[tvWatcher] %s → TV input', name);
        }
      }

      prevTvState = cur;
    } catch (e) {
      console.error('[tvWatcher] error:', e.message);
    }
  }, 10000);
}

module.exports = { start };
