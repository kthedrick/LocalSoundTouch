#!/usr/bin/env bash
# Deploy LocalSoundTouch to Home Assistant Pi
#
# ONE-TIME SETUP:
#   1. In HA: Settings → Add-ons → "Advanced SSH & Web Terminal" → Install
#   2. In that add-on's config, paste your public key (cat ~/.ssh/id_rsa.pub)
#   3. Set the fields below to match your HA instance
#   4. On Pi (via HA terminal): mkdir -p /addons/localsoundtouch
#   5. Run this script once, then install from:
#      HA → Settings → Apps → App Store → ⋮ → Check for updates → Local add-ons
#
# AFTER FIRST INSTALL:
#   Configure NAS credentials in the app options, then Start it.
#   For all future updates, just run: ./deploy.sh

set -e

PI_USER="root"
PI_ADDR="homeassistant"          # ← change to IP if hostname doesn't resolve
PI_PORT="22222"                  # ← Advanced SSH add-on default port
ADDON_SLUG="local_localsoundtouch"
ADDON_DIR="/addons/localsoundtouch"

SSH="ssh -p $PI_PORT $PI_USER@$PI_ADDR"

echo "→ Running tests ..."
node --test 'tests/**/*.test.js' || { echo "✗ Tests failed — deploy aborted."; exit 1; }

echo "→ Syncing files to $PI_ADDR:$ADDON_DIR ..."
tar -czf - \
  --exclude='./.git' \
  --exclude='./.claude' \
  --exclude='./tests' \
  --exclude='./*.pdf' \
  --exclude='./nasConfig.json' \
  --exclude='./haConfig.json' \
  --exclude='./tests.json' \
  --exclude='./node_modules' \
  . | $SSH "tar -xzf - -C $ADDON_DIR"

echo "→ Syncing haConfig.json ..."
cat haConfig.json | $SSH "cat > $ADDON_DIR/haConfig.json"

echo "→ Seeding tests.json (first deploy only) ..."
cat tests.json | $SSH "[ -f $ADDON_DIR/tests.json ] || cat > $ADDON_DIR/tests.json"

echo "→ Fixing line endings ..."
$SSH "sed -i 's/\r//' $ADDON_DIR/config.yaml $ADDON_DIR/Dockerfile $ADDON_DIR/run.sh"

echo "→ Rebuilding add-on (this rebuilds the Docker image) ..."
$SSH "ha apps rebuild $ADDON_SLUG"

echo "→ Starting add-on ..."
$SSH "ha apps start $ADDON_SLUG 2>/dev/null || true"

echo ""
echo "✓ Done! Open: http://$PI_ADDR:3000"
