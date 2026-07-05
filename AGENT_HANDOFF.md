# Agent Handoff — MA Queue Mismatch (false-positive banner)

**Owner of this task:** whichever Claude Kevin talks to next (PC or mobile).
**Date:** 2026-07-05
**Status:** Root-caused with high confidence. NOT yet fixed. Waiting on one piece of info from Kevin.

## Symptom (confirmed by Kevin)
Red **"MA Queue Mismatch"** banner appears in the UI **while audio is playing fine**. False positive — the audio is actually working. So this is over-eager detection, not a real desync.

## Where the code lives
- **Detection:** `haHandler.js` → `GET /ha/queue-health` (starts ~line 993). Gated behind `cfg.features.queueHealthCheck`.
- **Banner UI:** `public/js/app2.jsx:2790` (`queueHealthIssues`), polled from `/ha/queue-health` at `app2.jsx:1981`.

## How detection works
For each speaker in `cfg.speakerQueues`:
- **Bose:** if its MA queue `state === 'playing'` AND the **cached hardware source** `boseSources[name]` (from `boseWatcher`) `!== expected` (usually `AIRPLAY`, or the redirect's input) → raise issue `"MA playing but Bose on <src> (not AIRPLAY)"`.
- **Non-Bose (WiiM/Belkin):** if MA queue `state === 'playing'` AND the MA `player.state === 'idle'` → `"MA queue playing but player is idle"`; also warns if `player.powered === false`.

## Two candidate false-positive vectors (need banner text to disambiguate)
1. **Stale cached Bose source (MOST LIKELY).** `boseWatcher` refreshes source only every 60s (`POLL_MS = 60000`) plus WebSocket events. If a WS `nowPlayingUpdated` source-change is missed, `boseSources[name]` stays stale (e.g. `STANDBY`/`PRODUCT`) while MA genuinely plays via AirPlay → false banner. Live queue dump confirmed queues cycle idle↔playing rapidly (Sunroom/Living Room have `next_item` + resume positions), so transient lag is plausible.
2. **Synced / group-member player.** A WiiM synced to another player, or a Bose group *member*, can show its queue as `playing` while its own `player.state === 'idle'` or `powered === false` → false banner.

## NEEDED FROM KEVIN (ask him)
The **exact red text** under the banner while sound is playing. Format is `"<Speaker>: <issue>"`. That single line identifies which vector (1 or 2) and which speaker.

## Recommended fix (apply once banner text confirms vector)
- **Debounce:** only surface an issue if the same `(speaker, queueId)` mismatch persists across **two consecutive** `/ha/queue-health` polls. Kills transient flashes during track/source transitions. Requires keeping last-poll issue set server-side in `haHandler.js` (module-level Map keyed by queueId).
- **Don't warn on unknown/stale source:** skip the Bose check when `boseSources[name]` is falsy or older than ~2 poll intervals (add a timestamp to `boseWatcher`'s cached source so staleness is detectable).
- **Group/sync awareness:** in the non-Bose check, skip the idle/powered warning when the player is `synced_to` something or is an active AirPlay group member (queue is `playing` legitimately via the leader).
- Consider gating the banner off entirely (`features.queueHealthCheck: false` in haConfig.json) as an immediate mitigation until the fix ships.

## Immediate mitigation (no code change)
Set `features.queueHealthCheck` to `false` in `haConfig.json` on the Pi and redeploy — hides the banner now. Re-enable after the debounce fix.

---
*(Mobile: if you fix this, update this file or drop an `AGENT_REPLY.md` with the SHA and what changed.)*
