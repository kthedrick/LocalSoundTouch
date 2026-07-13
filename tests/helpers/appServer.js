// Real HTTP server around httpProxy.handleRequest — end-to-end request/response
// coverage without main.js (which starts watchers/scans at require time).
const http = require('http');

function startApp() {
  const handleRequest = require('../../httpProxy');
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      handleRequest(req, res, `http://127.0.0.1:${server.address().port}`);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        close() { return new Promise(r => server.close(r)); },
      });
    });
  });
}

module.exports = { startApp };
