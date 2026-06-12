// Music Assistant API client
// MA API: POST http://<host>:8095/api with { command, args }

const http = require('http');
const fs   = require('fs');
const path = require('path');

let _config = null;

function getConfig() {
  if (!_config) {
    try {
      _config = JSON.parse(fs.readFileSync(path.join(__dirname, 'haConfig.json'), 'utf8'));
    } catch (e) {
      console.warn('[maClient] haConfig.json not found:', e.message);
      _config = {};
    }
  }
  return _config;
}

// Reload config (call after haConfig.json is updated at runtime)
function reloadConfig() { _config = null; }

// Resolve playRedirects: some speakers (e.g. Bose-Bedroom) can't receive their own
// queue's audio — playback must go to a redirect target queue (e.g. Belkin adapter).
// Every code path that starts playback on a queue must resolve through this first.
function resolveQueueRedirect(queueId) {
  const cfg = getConfig();
  const redirect = (cfg.playRedirects || []).find(r => r.fromQueue === queueId);
  return redirect ? { queueId: redirect.toQueue, redirect } : { queueId, redirect: null };
}

async function maPost(command, args) {
  const cfg = getConfig();
  if (!cfg.maToken || cfg.maToken === 'YOUR_MA_TOKEN_HERE') {
    throw new Error('maToken not configured in haConfig.json');
  }

  const maUrl  = new URL(cfg.maUrl || 'http://homeassistant:8095');
  const body   = JSON.stringify({ command, args });

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: maUrl.hostname,
      port:     parseInt(maUrl.port) || 8095,
      path:     '/api',
      method:   'POST',
      headers: {
        'Authorization': 'Bearer ' + cfg.maToken,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('MA request timeout: ' + command)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const stopQueue    = (queueId)                       => maPost('player_queues/stop',          { queue_id: queueId });
const clearQueue   = (queueId)                       => maPost('player_queues/clear',         { queue_id: queueId });
const stopPlayer   = (playerId)                      => maPost('players/stop',                { player_id: playerId });
const getAllPlayers = ()                              => maPost('players/all',                 {});
// Add a single player to a target player's group (join-while-playing supported via AirPlay ring buffer)
const groupPlayer  = (playerId, targetPlayer)        => maPost('players/cmd/group',           { player_id: playerId, target_player: targetPlayer });
// Remove a single player from its current group
const ungroupPlayer = (playerId)                     => maPost('players/cmd/ungroup',         { player_id: playerId });
// Set the full member list for a group (use groupPlayer for single-speaker adds)
const setMembers   = (targetPlayer, playerIdsToAdd)  => maPost('players/cmd/set_members',     { target_player: targetPlayer, player_ids_to_add: playerIdsToAdd });
const pauseQueue   = (queueId)                       => maPost('player_queues/pause',         { queue_id: queueId });
const resumeQueue  = (queueId)                       => maPost('player_queues/play',          { queue_id: queueId });
const nextTrack    = (queueId)                       => maPost('player_queues/next',          { queue_id: queueId });
const prevTrack    = (queueId)                       => maPost('player_queues/previous',      { queue_id: queueId });
const getAllQueues  = ()                              => maPost('player_queues/all',           {});
const playMedia    = (queueId, uri)                  => maPost('player_queues/play_media',    { queue_id: queueId, media: uri, option: 'play' });

module.exports = { maPost, stopQueue, clearQueue, stopPlayer, getAllPlayers, groupPlayer, ungroupPlayer, setMembers, pauseQueue, resumeQueue, nextTrack, prevTrack, getAllQueues, playMedia, reloadConfig, getConfig, resolveQueueRedirect };
