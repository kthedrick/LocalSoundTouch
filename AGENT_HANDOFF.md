# Agent Handoff — MA Queue Mismatch (RESOLVED in code, pending deploy)

**Date:** 2026-07-05
**Status:** Root-caused and FIXED in code on PC (`main`). Not yet deployed to the Pi.

## Symptom (confirmed)
Red **"MA Queue Mismatch"** banner: `Bose-Sunroom 300: MA playing but Bose on STANDBY (not AIRPLAY)` — while audio was actually playing fine. False positive.

## Root cause
`boseWatcher.js` keeps a shared `lastSource` cache. It was updated **only by the WebSocket** path (`nowPlayingUpdated`). The 60s HTTP poll (`pollSpeaker`) read the source into a *local* `prev` but never wrote `lastSource`. So when the WS went stale (missed the AIRPLAY transition / reconnected), `lastSource["Bose-Sunroom 300"]` stayed at `STANDBY` even though the poll correctly saw `AIRPLAY` (which is why audio kept working — no phantom action taken). `/ha/queue-health` reads `getSources()` → stale `STANDBY` → false banner.

## Fix (committed)
1. **`boseWatcher.js` (pollSpeaker):** now sets `lastSource[name] = source;` on every poll, so the shared cache can't be WS-only-stale. Root-cause fix.
2. **`haHandler.js` (/ha/queue-health):** added a debounce — a mismatch is reported only if the same `queueId|issue` was present on the previous poll too. Kills transient flashes during track/source transitions. Module-level `prevQueueHealthKeys`.

## To make it live
Run `./deploy.sh` from the PC (tar + SSH to Pi, rebuild add-on, ~30s). This interrupts current playback briefly. No haConfig.json change needed.

## Verify after deploy
Play something on Sunroom via MA; confirm the banner does NOT appear. If a *real* mismatch ever occurs (speaker actually on TV/Bluetooth while MA plays), it should still show after ~two poll cycles.
