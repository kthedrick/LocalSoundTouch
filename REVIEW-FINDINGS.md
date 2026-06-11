# Code Review Findings — 2026-06-11

Full-project review: all server modules, app2.jsx (incl. uncommitted volume-safety work), config, deploy chain.
Status legend: `[ ]` open · `[x]` fixed · `[~]` won't fix / deferred.

---

## P1 — Bugs, fix first

### [ ] 1. TDZ crash kills S2b album fallback
**File:** `hybridOrchestrator.js:542-543` (inside `fetchAlbum`, Strategy 2b)
```js
if (!artistMatches(aArtist, normalizedArtist, aName)) continue;  // 542 — aName used
const aName = (album.name || '').toLowerCase();                  // 543 — declared after
```
ReferenceError every time S2b runs (S1+S2 both miss). Outer catch swallows → logs
`[hybrid] fetchAlbum error: Cannot access 'aName' before initialization` → track treated
as "no album found", skipped. Artist-fallback albums never play in playlist album mode.

**Fix:** `findAlbumTracks` (line ~150) has correct copy of same loop. Best: delete
`fetchAlbum`'s inline S1/S2/S2b (~120 lines) and call `findAlbumTracks` — also gains S2p
performer strategy `fetchAlbum` lacks. Minimal: move `aName` declaration above use.

### [ ] 2. Test/usage data wiped every deploy
**Files:** `testsHandler.js:4`, `usageHandler.js:4`
Both write to `__dirname` = `/app` inside container. `ha apps rebuild` discards container
FS → tests.json results, fail snapshots, usage.json counts (drives speaker card ordering)
reset on every `deploy.sh`.

**Fix:** copy pattern from `pandoraTracker.js:18`:
```js
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
```
One-time migration: copy current `/app/tests.json` → `/data/tests.json` on Pi before next rebuild.

### [ ] 3. applyGroupSideEffects uses forbidden leader check
**File:** `haHandler.js:127`
`if (members[0] !== state.entity_id) continue` — exact pattern CLAUDE.md forbids
(breaks Joshua/Rosemary group_members shape). Leader listing only members → skipped;
member listing only itself → 1-element group → discarded. Bass-switch rule can evaluate
`grouped=false` while Sunroom+LivingRoom actually grouped → `switch.living_room_bass`
turned OFF mid-listening. Also reads HA entity state 1.5s post-change — same lag that
forced MA supplementation in `/ha/group-state`.

**Fix:** reuse `/ha/group-state` detection ("any entity with OTHER known entities in
group_members is leader" + MA `synced_to` supplement). Extract shared `getActiveGroups()`
helper; both call sites use it.

### [ ] 4. playRedirects enforced only in /ha/play — Bedroom playback paths broken
**Files:** `haHandler.js` (`/ha/pandora-play-playlist` ~571, `/ha/play-playlist-album`,
`/ha/album-once`, `/ha/station-uri` ~588), `hybridOrchestrator.js` (`startPlaylist`,
`advanceToNextTrack`, `playAlbum`, `startAlbumOnce`)
All call `playMedia`/`play_media` with raw queue ID. For Bose-Bedroom that's its
AirPlay-less Bose queue → phantom playback (audio nowhere; boseWatcher later kills it).
Also "This Album" button: `/ha/play` stores station URI under redirected (Belkin) queue,
UI queries original queue → always "No station URI — play Pandora first".

**Fix:** server-side helper `resolvePlayQueue(queueId)` applying `playRedirects`
(+ `boseSwitchInput` side effect); every play path routes through it. `/ha/station-uri`
checks both original and redirect queue keys.

### [ ] 5. Volume safety check misses first jump (UNCOMMITTED work)
**File:** `public/js/app2.jsx:2343-2364` (`onVolumeChange`)
No-baseline path only creates baseline then applies unchecked — single 40→90 slider jump
(SoundSettingsModal) passes silently; modal then fires later on innocent +1 nudge
(level − stale baseline > 10). Hole AND false positive.

**Fix:** on no-baseline path, if `level - currentVol > 10 && level > 50` → prompt
immediately (treat currentVol as baseline).

---

## P2 — Bugs, fix soon

### [ ] 6. boseWatcher bound to boot-time IP list forever
**File:** `boseWatcher.js:360` (`start`)
Runs once with startup discovery. Speaker offline at boot → never watched. DHCP renumber
→ WS reconnect-loops dead IP, poll spams dead IP, `lastSource` stale (feeds
`/ha/queue-health`). Contradicts CLAUDE.md "all logic uses Bose device names not IPs".
**Fix:** consume `speakerDiscovery` rescans (every 30s); diff IP-per-name, restart
watcher on change, start watcher for newly seen speakers.
Also: header comment says "poll every 8s"; `POLL_MS = 60000` — fix comment.

### [ ] 7. pendingGroups never cleared after establishGroup
**File:** `public/js/app2.jsx:2664-2685`
Stale checked-state survives join; member later removed from group reappears pre-checked;
next tap silently un-pends instead of joining.
**Fix:** clear `pendingGroups[leaderIp]` after successful group-include.

### [ ] 8. GroupCard volume ±1-taps only (UNCOMMITTED — confirm intent)
**File:** `public/js/app2.jsx:1452-1469`
Slider replaced with display-only bar. +30 volume = 30 taps = 30 immediate POSTs; safety
modal interrupts every +11 above 50 (re-arms after each confirm). If kid-proofing
intentional, keep — but add hold-to-repeat auto-increment or tap-position-on-bar to set.

---

## P3 — Minor / latent

### [ ] 9. Cache-buster breaks MIME detection
`upnpHandler.js:264` — `&_t=` appended to `/nas/stream?path=…` → `contentTypeFromUrl`
regex (needs `.ext` before `?` or end) misses → DIDL protocolInfo always `audio/mpeg`
for FLAC/M4A. Latent — speakers trust HTTP Content-Type (nasHandler sets correctly).
**Fix:** strip query before extension match, or pass original URL for MIME.

### [ ] 10. Pandora playlist lookup miss stored permanently
`pandoraTracker.js:99-107` — lookup miss or transient search error → `maPlaylistId=false`
forever; MA playlist created later never syncs. **Fix:** retry `false` on server restart
or every N days; don't persist `false` on caught error.

### [ ] 11. No timeouts on MA/HA HTTP requests
`maClient.js` `maPost`, `haHandler.js` `haGet`/`haServicePost`, `tvWatcher.js` `haGet` —
hung request hangs endpoint + pollers. **Fix:** `req.setTimeout(10000, () => req.destroy(...))`.

### [ ] 12. tests.html esc() misses quotes
`public/tests.html` — `esc()` lacks `"` → `&quot;`; note containing quote breaks
`value="…"` attribute.

### [ ] 13. Duplicate MA now-playing polling
`app2.jsx:1971` effect fires per speaker-update (10+× per poll cycle), fetching
`/ha/queue-now-playing` per AirPlay speaker — on top of dedicated 5s poll at :2058.
**Fix:** drop fetch from speakerData effect (keep only stale-clear logic); 5s poll suffices.

### [ ] 14. CDN dependency — UI dies offline
`index.html`/`app2.html` load React/Babel/Tailwind from unpkg/cdn. Internet outage kills
fully-local stack. **Fix:** vendor 3 static files into `public/vendor/` (one-time
download, no npm).

### [ ] 15. Config / doc drift
- `haConfig.json` `features.albumDive` — referenced nowhere in code. Stale; remove.
- CLAUDE.md says Belkin queue `upcc4b73fe2466`; haConfig has `upuuidff970010315bf140af4f0142ff970010`. Update CLAUDE.md.

### [ ] 16. Dead code
- `app2.jsx:2222` `syncSpeakerTo` — never called (~35 lines)
- `app2.jsx` `onMaStop`, `stopRestartEnabled`/`onToggleStopRestart` props + `stopRestartByZone` state — passed to GroupCard, never used
- `app2.jsx:1824` `loading` never set true — branch unreachable
- `public/js/app.jsx` (807 lines) — nothing loads it
- `public/app2.html` — duplicate of index.html
- `bose-proxy-server.js` — legacy standalone, hardcoded stale IPs
- `.claude/worktrees/strange-dijkstra-3c938b` — stale agent worktree
(`boseWatcher.polling.js` intentional — documented revert path; keep.)

---

## Verification notes for fixes

- #1: trigger album mode on track with no album metadata (2CELLOS case) — expect S2b album, no TDZ log line
- #2: deploy twice; tests.json results persist
- #3: group Sunroom+LivingRoom → bass switch ON; ungroup → OFF; works regardless of group_members shape
- #4: play Local Playlist on Bose-Bedroom → audio via Belkin/AUX1; "This Album" works on Bedroom
- #5: from vol 40, single jump to 90 in SoundSettingsModal → modal appears before apply
- #6: restart server with one speaker unplugged, plug in later → watcher attaches within ~60s
