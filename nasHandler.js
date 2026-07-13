const path = require('path');
const fs   = require('fs');
const ftp  = require('./ftpClient');

const MIME = {
  '.mp3':  'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a':  'audio/mp4',
  '.aac':  'audio/aac',
  '.wma':  'audio/x-ms-wma',
  '.ogg':  'audio/ogg',
  '.wav':  'audio/wav',
  '.alac': 'audio/mp4',
};

// Exact names to check first (lowercase), in priority order
const ART_NAMES_EXACT = ['folder.jpg', 'folder.jpeg', 'cover.jpg', 'cover.jpeg', 'cover.png', 'albumartsmall.jpg', 'albumart.jpg', 'album.jpg', 'front.jpg'];

async function findArtFile(host, username, password, folderPath) {
  try {
    const all = await ftp.listAll(host, username, password, folderPath);
    const lower = all.map(f => ({ orig: f, low: f.toLowerCase() }));

    // Prefer WMP large GUID art first — highest quality
    const large = lower.find(f => /^albumart_\{[^}]+\}_large\.jpg$/i.test(f.low));
    if (large) return large.orig;

    // Then check known exact names
    for (const name of ART_NAMES_EXACT) {
      const match = lower.find(f => f.low === name);
      if (match) return match.orig;
    }

    // Fallback: WMP small GUID art
    const small = lower.find(f => /^albumart_\{[^}]+\}_small\.jpg$/i.test(f.low));
    if (small) return small.orig;
  } catch (_) {}
  return null;
}

function getConfig() {
  const cfg = JSON.parse(fs.readFileSync(process.env.LST_NAS_CONFIG || path.join(__dirname, 'nasConfig.json'), 'utf8'));
  return cfg;
}

async function handleBrowse(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const ftpPath = url.searchParams.get('path') || '/';
  try {
    const cfg = getConfig();
    const [entries, artFile] = await Promise.all([
      ftp.list(cfg.host, cfg.username, cfg.password, ftpPath),
      findArtFile(cfg.host, cfg.username, cfg.password, ftpPath),
    ]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ path: ftpPath, artFile: artFile || null, ...entries }));
  } catch (err) {
    console.error('[NAS browse]', err.message);
    res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleArt(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const ftpPath = url.searchParams.get('path') || '';
  if (!ftpPath) { res.writeHead(400); res.end('path required'); return; }

  const ext = path.extname(ftpPath).toLowerCase();
  const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';

  try {
    const cfg = getConfig();
    const { dataSocket, ctrl } = await ftp.retrieve(cfg.host, cfg.username, cfg.password, ftpPath);
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' });
    dataSocket.pipe(res);
    dataSocket.on('end', () => { try { ctrl.end(); } catch (_) {} });
    dataSocket.on('error', () => { try { ctrl.destroy(); } catch (_) {} });
    res.on('close', () => { try { dataSocket.destroy(); ctrl.destroy(); } catch (_) {} });
  } catch (err) {
    console.error('[NAS art]', err.message);
    if (!res.headersSent) { res.writeHead(404); res.end('Not found'); }
  }
}

async function handleStream(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const ftpPath = url.searchParams.get('path') || '';
  if (!ftpPath) { res.writeHead(400); res.end('path required'); return; }

  const ext = path.extname(ftpPath).toLowerCase();
  const contentType = MIME[ext] || 'audio/mpeg';

  try {
    const cfg = getConfig();

    const fileSize = await ftp.getFileSize(cfg.host, cfg.username, cfg.password, ftpPath);

    // Parse Range header (e.g. "bytes=12345-")
    const rangeHeader = req.headers['range'];
    let startByte = 0;
    if (rangeHeader && fileSize) {
      const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (m) startByte = parseInt(m[1]);
    }

    const { dataSocket, ctrl } = await ftp.retrieve(cfg.host, cfg.username, cfg.password, ftpPath, startByte);

    const headers = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    };

    if (fileSize) {
      headers['Content-Length'] = fileSize - startByte;
      if (startByte > 0) {
        headers['Content-Range'] = `bytes ${startByte}-${fileSize - 1}/${fileSize}`;
      }
    }

    res.writeHead(startByte > 0 ? 206 : 200, headers);
    dataSocket.pipe(res);
    dataSocket.on('end', () => { try { ctrl.end(); } catch (_) {} });
    dataSocket.on('error', () => { try { ctrl.destroy(); } catch (_) {} });
    res.on('close', () => { try { dataSocket.destroy(); ctrl.destroy(); } catch (_) {} });
  } catch (err) {
    console.error('[NAS stream]', err.message);
    if (!res.headersSent) { res.writeHead(500); res.end(err.message); }
  }
}

async function handleM3u(req, res, serverBase) {
  const url = new URL(req.url, 'http://localhost');
  const ftpPath = url.searchParams.get('path') || '/';
  try {
    const cfg = getConfig();
    const { files } = await ftp.list(cfg.host, cfg.username, cfg.password, ftpPath);

    const lines = ['#EXTM3U'];
    for (const f of files) {
      const filePath = ftpPath.replace(/\/$/, '') + '/' + f;
      lines.push(`#EXTINF:0,${f.replace(/\.[^.]+$/, '')}`);
      lines.push(`${serverBase}/nas/stream?path=${encodeURIComponent(filePath)}`);
    }
    res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
    res.end(lines.join('\n'));
  } catch (err) {
    console.error('[NAS m3u]', err.message);
    res.writeHead(500); res.end(err.message);
  }
}

module.exports = function handleNas(req, res, serverBase) {
  const urlPath = req.url.split('?')[0];
  if (urlPath === '/nas/browse') return handleBrowse(req, res);
  if (urlPath === '/nas/stream') return handleStream(req, res);
  if (urlPath === '/nas/art')    return handleArt(req, res);
  if (urlPath === '/nas/m3u')    return handleM3u(req, res, serverBase);
  res.writeHead(404); res.end('Not found');
};
