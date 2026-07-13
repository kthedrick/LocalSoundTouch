// Test environment bootstrap. MUST be required before any app module so the
// LST_* overrides are in place when modules compute config/data paths at load.
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'lst-'));
const dataDir = path.join(tmpDir, 'data');
fs.mkdirSync(dataDir);

process.env.LST_DATA_DIR   = dataDir;
process.env.LST_HA_CONFIG  = path.join(tmpDir, 'haConfig.json');
process.env.LST_NAS_CONFIG = path.join(tmpDir, 'nasConfig.json');

function cleanup() {
  // Close servers before calling this — Windows holds locks on open files.
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

module.exports = { tmpDir, dataDir, cleanup };
