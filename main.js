// Run with: node main.js
// Open: http://localhost:3000

const http = require('http');
const httpProxy = require('./httpProxy');
const wsProxy = require('./wsProxy');
const speakerDiscovery = require('./speakerDiscovery');

const PORT = 3000;

const server = http.createServer(httpProxy);
server.on('upgrade', wsProxy);

server.listen(PORT, async () => {
  console.log('\n🎵 SoundTouch Controller running at http://localhost:' + PORT);
  console.log('Open your browser to http://localhost:' + PORT + '\n');

  await speakerDiscovery.discoverSpeakers();
  setInterval(() => speakerDiscovery.discoverSpeakers().catch(() => {}), 30000);
});
