// SMB mount no longer used — NAS access is via FTP (see ftpClient.js)
function mountNas() {}
function getUncRoot() { return null; }
module.exports = { mountNas, getUncRoot };
