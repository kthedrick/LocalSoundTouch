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

function getConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'nasConfig.json'), 'utf8'));
  return cfg;
}

async function handleBrowse(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const ftpPath = url.searchParams.get('path') || '/';
  try {
    const cfg = getConfig();
    const entries = await ftp.list(cfg.host, cfg.username, cfg.password, ftpPath);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ path: ftpPath, ...entries }));
  } catch (err) {
    console.error('[NAS browse]', err.message);
    res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
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

    // Try to get file size for Content-Length (enables seeking)
    const fileSize = await ftp.getFileSize(cfg.host, cfg.username, cfg.password, ftpPath);

    const { dataSocket, ctrl } = await ftp.retrieve(cfg.host, cfg.username, cfg.password, ftpPath);

    const headers = { 'Content-Type': contentType, 'Accept-Ranges': 'none' };
    if (fileSize) headers['Content-Length'] = fileSize;

    res.writeHead(200, headers);
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
  if (urlPath === '/nas/m3u')    return handleM3u(req, res, serverBase);
  res.writeHead(404); res.end('Not found');
};
