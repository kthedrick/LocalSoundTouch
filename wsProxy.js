const net = require('net');

module.exports = function handleUpgrade(req, socket, head) {
  const parts = req.url.split('/');
  if (parts[1] !== 'ws' || !parts[2]) { socket.destroy(); return; }
  const ip = parts[2];
  const target = net.createConnection({ host: ip, port: 8080 });
  target.on('connect', () => {
    const upgradeRequest = [
      'GET /WebSocket HTTP/1.1',
      'Host: ' + ip + ':8080',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: ' + (req.headers['sec-websocket-key'] || 'dGhlIHNhbXBsZSBub25jZQ=='),
      'Sec-WebSocket-Version: ' + (req.headers['sec-websocket-version'] || '13'),
      'Sec-WebSocket-Protocol: gabbo',
      '', ''
    ].join('\r\n');
    target.write(upgradeRequest);
    if (head && head.length) target.write(head);
    target.pipe(socket);
    socket.pipe(target);
  });
  target.on('error', err => { console.error('WS proxy error:', err.message); socket.end(); });
  socket.on('error', () => target.destroy());
  socket.on('close', () => target.destroy());
};
