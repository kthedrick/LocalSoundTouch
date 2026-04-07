// Minimal FTP client using Node.js built-in net module (no npm required)
const net = require('net');
const path = require('path');

const TIMEOUT_MS = 8000;

function openControl(host, port = 21) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, host);
    socket.setTimeout(TIMEOUT_MS);
    socket.once('error', reject);
    socket.once('timeout', () => reject(new Error('FTP connect timeout')));
    waitReply(socket).then(() => resolve(socket)).catch(reject);
  });
}

// Wait for a complete FTP reply (ends with "NNN <text>\r\n")
function waitReply(socket) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (data) => {
      buf += data.toString();
      // Replies: "NNN-..." (multi-line) then "NNN text" (final)
      const lines = buf.split('\r\n');
      for (const line of lines) {
        if (/^\d{3} /.test(line)) {
          socket.removeListener('data', onData);
          socket.removeListener('error', onErr);
          const code = parseInt(line);
          if (code >= 400) reject(new Error(line));
          else resolve({ code, text: buf });
          return;
        }
      }
    };
    const onErr = (e) => { socket.removeListener('data', onData); reject(e); };
    socket.on('data', onData);
    socket.once('error', onErr);
  });
}

function cmd(socket, command) {
  socket.write(command + '\r\n');
  return waitReply(socket);
}

async function login(socket, user, pass) {
  await cmd(socket, `USER ${user}`);
  await cmd(socket, `PASS ${pass}`);
  try { await cmd(socket, 'TYPE I'); } catch (_) {} // binary mode, ignore if unsupported
}

async function pasv(socket) {
  const { text } = await cmd(socket, 'PASV');
  const m = text.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
  if (!m) throw new Error('Cannot parse PASV response: ' + text);
  const ip   = `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
  const port = parseInt(m[5]) * 256 + parseInt(m[6]);
  return { ip, port };
}

function openData(ip, port) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(port, ip);
    s.setTimeout(TIMEOUT_MS);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
    s.once('timeout', () => reject(new Error('FTP data timeout')));
  });
}

function collectStream(dataSocket) {
  return new Promise((resolve, reject) => {
    let buf = '';
    dataSocket.on('data', d => buf += d.toString());
    dataSocket.on('end', () => resolve(buf));
    dataSocket.on('error', reject);
  });
}

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.wma', '.ogg', '.wav', '.alac']);

function parseListing(raw) {
  const folders = [], files = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;

    let isDir = false, name = '';

    // Unix style: drwxr-xr-x 2 user group 4096 Jan 01 12:00 Name
    const unix = t.match(/^([dl-])[\w-]{9}\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/);
    if (unix) {
      isDir = unix[1] === 'd';
      name  = unix[2].trim();
    } else {
      // Windows/DOS style: 01-01-24  12:00AM <DIR>          Name
      const win = t.match(/^\S+\s+\S+\s+(<DIR>|\d+)\s+(.+)$/);
      if (win) { isDir = win[1] === '<DIR>'; name = win[2].trim(); }
    }

    if (!name || name === '.' || name === '..') continue;
    if (isDir) folders.push(name);
    else if (AUDIO_EXTS.has(path.extname(name).toLowerCase())) files.push(name);
  }

  const cmp = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  return { folders: folders.sort(cmp), files: files.sort(cmp) };
}

// ── Public API ────────────────────────────────────────────────────────────────

async function list(host, user, pass, ftpPath) {
  const ctrl = await openControl(host);
  try {
    await login(ctrl, user, pass);
    const { ip, port } = await pasv(ctrl);
    const data = await openData(ip, port);
    ctrl.write(`LIST ${ftpPath || '/'}\r\n`);
    const raw = await collectStream(data);
    ctrl.end();
    return parseListing(raw);
  } catch (err) {
    ctrl.destroy();
    throw err;
  }
}

async function getFileSize(host, user, pass, ftpPath) {
  const ctrl = await openControl(host);
  try {
    await login(ctrl, user, pass);
    const { text } = await cmd(ctrl, `SIZE ${ftpPath}`);
    ctrl.end();
    const m = text.match(/213 (\d+)/);
    return m ? parseInt(m[1]) : null;
  } catch (_) {
    ctrl.destroy();
    return null;
  }
}

// Returns { dataSocket, ctrl } — caller must pipe dataSocket and then ctrl.end()
async function retrieve(host, user, pass, ftpPath) {
  const ctrl = await openControl(host);
  try {
    await login(ctrl, user, pass);
    const { ip, port } = await pasv(ctrl);
    const dataSocket = await openData(ip, port);
    ctrl.write(`RETR ${ftpPath}\r\n`);
    return { dataSocket, ctrl };
  } catch (err) {
    ctrl.destroy();
    throw err;
  }
}

module.exports = { list, retrieve, getFileSize };
