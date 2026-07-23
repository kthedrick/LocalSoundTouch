// Recently played search results — lets kids re-play the same song/artist they just found.
// Persisted server-side (the browser may close; the Pi keeps the list) in the same /data
// dir the Pandora tracker uses.

const fs   = require('fs');
const path = require('path');

const DATA_DIR = process.env.LST_DATA_DIR || (fs.existsSync('/data') ? '/data' : __dirname);
const FILE     = path.join(DATA_DIR, 'recentSearches.json');
const MAX      = 40;

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

function save(list) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

// Record a played item at the top of the list. Dedups by uri (most-recent play wins) and
// caps the list at MAX. Returns the updated list.
function add(entry) {
  if (!entry || !entry.uri) return load();
  const str = (v, n) => (v == null ? '' : String(v)).slice(0, n);
  const clean = {
    type:      entry.type === 'artist' ? 'artist' : 'track',
    name:      str(entry.name, 300),
    uri:       String(entry.uri),
    artist:    str(entry.artist, 300),
    artistUri: entry.artistUri ? String(entry.artistUri) : null,
    image:     entry.image ? str(entry.image, 1000) : null,
    playedAt:  new Date().toISOString(),
  };
  let list = load().filter(e => e.uri !== clean.uri);
  list.unshift(clean);
  if (list.length > MAX) list = list.slice(0, MAX);
  save(list);
  return list;
}

function list(limit = 30) { return load().slice(0, limit); }

module.exports = { load, save, add, list };
