#!/bin/sh
set -e

# Write nasConfig.json from HA add-on options (/data/options.json)
node -e "
const fs = require('fs');
try {
  const opts = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
  fs.writeFileSync('/app/nasConfig.json', JSON.stringify({
    host:     opts.nas_host,
    share:    opts.nas_share,
    username: opts.nas_username,
    password: opts.nas_password
  }));
  console.log('[run.sh] NAS config written from add-on options');
} catch (e) {
  console.log('[run.sh] Could not read options.json:', e.message);
  console.log('[run.sh] Proceeding without NAS config');
}
"

exec node /app/main.js
