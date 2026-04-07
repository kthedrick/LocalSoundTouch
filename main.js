// Run with: node main.js
// Open: http://localhost:3000

const http = require('http');
const os = require('os');
const httpProxy = require('./httpProxy');
const wsProxy = require('./wsProxy');
const speakerDiscovery = require('./speakerDiscovery');
const { mountNas } = require('./nasMount');

const PORT = 3000;

// Detect LAN IP
function getLanIp() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

const LAN_IP = getLanIp();
const SERVER_BASE = `http://${LAN_IP}:${PORT}`;

const server = http.createServer((req, res) => httpProxy(req, res, SERVER_BASE));
server.on('upgrade', wsProxy);

server.listen(PORT, async () => {
  console.log('\n🎵 SoundTouch Controller running at http://localhost:' + PORT);
  console.log('   LAN address: ' + SERVER_BASE + '\n');

  mountNas();

  await speakerDiscovery.discoverSpeakers();
  setInterval(() => speakerDiscovery.discoverSpeakers().catch(() => {}), 30000);
});
