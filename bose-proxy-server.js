// Save as: bose-proxy.js
// Run with: node bose-proxy.js
// Then open: http://localhost:3000

const http = require('http');
const https = require('https');

const PORT = 3000;

const server = http.createServer((req, res) => {
  // Enable CORS for all requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Serve the HTML page
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML_CONTENT);
    return;
  }

  // Proxy API requests
  if (req.url.startsWith('/api/')) {
    const parts = req.url.split('/');
    const ip = parts[2]; // Extract IP from /api/192.168.1.229/volume
    const endpoint = '/' + parts.slice(3).join('/');
    
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      const options = {
        hostname: ip,
        port: 8090,
        path: endpoint,
        method: req.method,
        headers: body ? { 'Content-Type': 'application/xml' } : {}
      };

      const proxyReq = http.request(options, (proxyRes) => {
        let data = '';
        proxyRes.on('data', chunk => {
          data += chunk;
        });
        proxyRes.on('end', () => {
          res.writeHead(proxyRes.statusCode, { 'Content-Type': 'text/xml' });
          res.end(data);
        });
      });

      proxyReq.on('error', (error) => {
        console.error('Proxy error:', error);
        res.writeHead(500);
        res.end('Proxy error: ' + error.message);
      });

      if (body) {
        proxyReq.write(body);
      }
      proxyReq.end();
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n🎵 Bose SoundTouch Controller running at http://localhost:${PORT}`);
  console.log(`Open your browser to http://localhost:${PORT}\n`);
});

const HTML_CONTENT = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bose SoundTouch Controller</title>
    <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body>
    <div id="root"></div>

    <script type="text/babel">
        const { useState, useEffect } = React;

        const SPEAKERS = [
          { ip: '192.168.1.229', name: 'Sunroom' },
          { ip: '192.168.1.164', name: 'Office' },
          { ip: '192.168.1.247', name: 'Bathroom' },
          { ip: '192.168.1.36', name: 'Rosemary' },
          { ip: '192.168.1.94', name: 'Joshua' },
          { ip: '192.168.1.171', name: 'Living Room' },
          { ip: '192.168.1.185', name: 'Kitchen' },
          { ip: '192.168.1.176', name: 'Main Bedroom' },
          { ip: '192.168.1.62', name: 'Dining Room' },
          { ip: '192.168.1.13', name: 'Patio' }
        ];

        function BoseSoundTouchController() {
          const [selectedSpeaker, setSelectedSpeaker] = useState(null);
          const [volume, setVolume] = useState(50);
          const [nowPlaying, setNowPlaying] = useState(null);
          const [presets, setPresets] = useState([]);
          const [loading, setLoading] = useState(false);

          const sendCommand = async (endpoint, method = 'GET', body = null) => {
            if (!selectedSpeaker) return;
            
            try {
              const response = await fetch(\`/api/\${selectedSpeaker.ip}\${endpoint}\`, {
                method,
                headers: body ? { 'Content-Type': 'application/xml' } : {},
                body
              });
              return await response.text();
            } catch (error) {
              console.error('Error:', error.message);
              return null;
            }
          };

          const selectSpeaker = async (speaker) => {
            setSelectedSpeaker(speaker);
            setLoading(true);
            
            await Promise.all([
              fetchVolume(speaker),
              fetchNowPlaying(speaker),
              fetchPresets(speaker)
            ]);
            
            setLoading(false);
          };

          const fetchVolume = async (speaker = selectedSpeaker) => {
            if (!speaker) return;
            try {
              const response = await fetch(\`/api/\${speaker.ip}/volume\`);
              const text = await response.text();
              const match = text.match(/<actualvolume>(\\d+)<\\/actualvolume>/);
              if (match) setVolume(parseInt(match[1]));
            } catch (error) {
              console.error('Volume fetch error:', error);
            }
          };

          const fetchNowPlaying = async (speaker = selectedSpeaker) => {
            if (!speaker) return;
            try {
              const response = await fetch(\`/api/\${speaker.ip}/now_playing\`);
              const text = await response.text();
              const parser = new DOMParser();
              const xml = parser.parseFromString(text, 'text/xml');
              
              setNowPlaying({
                artist: xml.querySelector('artist')?.textContent || '',
                track: xml.querySelector('track')?.textContent || '',
                album: xml.querySelector('album')?.textContent || '',
                source: xml.querySelector('source')?.textContent || '',
                art: xml.querySelector('art')?.textContent || ''
              });
            } catch (error) {
              console.error('Now playing fetch error:', error);
            }
          };

          const fetchPresets = async (speaker = selectedSpeaker) => {
            if (!speaker) return;
            try {
              const response = await fetch(\`/api/\${speaker.ip}/presets\`);
              const text = await response.text();
              console.log('Presets XML:', text);
              
              const parser = new DOMParser();
              const xml = parser.parseFromString(text, 'text/xml');
              const presetNodes = xml.querySelectorAll('preset');
              
              const presetList = Array.from(presetNodes).map(preset => {
                const id = preset.getAttribute('id');
                const itemName = preset.querySelector('ContentItem itemName')?.textContent;
                const source = preset.querySelector('ContentItem')?.getAttribute('source');
                
                console.log(\`Preset \${id}:\`, itemName, source);
                
                return {
                  id: id,
                  name: itemName || \`Preset \${id}\`,
                  source: source || ''
                };
              });
              
              console.log('Parsed presets:', presetList);
              setPresets(presetList);
            } catch (error) {
              console.error('Presets fetch error:', error);
            }
          };

          const setVolumeLevel = async (level) => {
            const xml = \`<volume>\${level}</volume>\`;
            await sendCommand('/volume', 'POST', xml);
            setVolume(level);
          };

          const pressKey = async (key) => {
            const xml = \`<key state="press" sender="Gabbo">\${key}</key>\`;
            await sendCommand('/key', 'POST', xml);
            
            const releaseXml = \`<key state="release" sender="Gabbo">\${key}</key>\`;
            setTimeout(() => sendCommand('/key', 'POST', releaseXml), 100);
            
            setTimeout(() => fetchNowPlaying(), 500);
          };

          const selectPreset = async (presetId) => {
            const xml = \`<key state="press" sender="Gabbo">PRESET_\${presetId}</key>\`;
            await sendCommand('/key', 'POST', xml);
            
            const releaseXml = \`<key state="release" sender="Gabbo">PRESET_\${presetId}</key>\`;
            setTimeout(() => sendCommand('/key', 'POST', releaseXml), 100);
            
            setTimeout(() => fetchNowPlaying(), 1000);
          };

          useEffect(() => {
            if (selectedSpeaker) {
              const interval = setInterval(() => fetchNowPlaying(), 5000);
              return () => clearInterval(interval);
            }
          }, [selectedSpeaker]);

          return (
            <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-6">
              <div className="max-w-6xl mx-auto">
                <div className="bg-slate-800 rounded-2xl shadow-2xl overflow-hidden border border-slate-700">
                  <div className="bg-gradient-to-r from-blue-600 to-blue-700 p-6">
                    <h1 className="text-3xl font-bold text-white mb-2">SoundTouch Control</h1>
                    <p className="text-blue-100 text-sm">Multi-room audio management</p>
                  </div>

                  {!selectedSpeaker ? (
                    <div className="p-6">
                      <h2 className="text-xl font-semibold text-white mb-4">Select a Speaker</h2>
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                        {SPEAKERS.map((speaker) => (
                          <button
                            key={speaker.ip}
                            onClick={() => selectSpeaker(speaker)}
                            className="p-4 bg-slate-700 hover:bg-slate-600 rounded-xl transition group"
                          >
                            <svg className="mx-auto mb-2 text-blue-400 group-hover:text-blue-300" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M11 5L6 9H2v6h4l5 4V5z"/>
                              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
                            </svg>
                            <p className="text-white font-medium text-sm">{speaker.name}</p>
                            <p className="text-slate-400 text-xs mt-1">{speaker.ip}</p>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : loading ? (
                    <div className="p-12 text-center">
                      <p className="text-slate-300">Loading speaker data...</p>
                    </div>
                  ) : (
                    <div className="p-6 space-y-6">
                      <div className="flex items-center justify-between bg-slate-700 rounded-xl p-4">
                        <div className="flex items-center gap-3">
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-400">
                            <path d="M11 5L6 9H2v6h4l5 4V5z"/>
                            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
                          </svg>
                          <div>
                            <p className="text-white font-semibold">{selectedSpeaker.name}</p>
                            <p className="text-slate-400 text-sm">{selectedSpeaker.ip}</p>
                          </div>
                        </div>
                        <button
                          onClick={() => {
                            setSelectedSpeaker(null);
                            setNowPlaying(null);
                            setPresets([]);
                          }}
                          className="px-4 py-2 bg-slate-600 hover:bg-slate-500 text-white rounded-lg text-sm transition"
                        >
                          Change Speaker
                        </button>
                      </div>

                      {nowPlaying && (
                        <div className="bg-slate-700 rounded-xl p-4">
                          <div className="flex items-start gap-4">
                            {nowPlaying.art && (
                              <img src={nowPlaying.art} alt="Album art" className="w-24 h-24 rounded-lg shadow-lg" />
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="text-white font-semibold text-lg truncate">
                                {nowPlaying.track || 'No track playing'}
                              </p>
                              <p className="text-slate-300 truncate">{nowPlaying.artist}</p>
                              <p className="text-slate-400 text-sm truncate">{nowPlaying.album}</p>
                              <p className="text-blue-400 text-xs mt-1 uppercase">{nowPlaying.source}</p>
                            </div>
                          </div>
                        </div>
                      )}

                      <div className="flex justify-center gap-3">
                        <button onClick={() => pressKey('POWER')} className="p-4 bg-slate-700 hover:bg-slate-600 text-white rounded-full transition" title="Power">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/>
                            <line x1="12" y1="2" x2="12" y2="12"/>
                          </svg>
                        </button>
                        <button onClick={() => pressKey('PREV_TRACK')} className="p-4 bg-slate-700 hover:bg-slate-600 text-white rounded-full transition" title="Previous">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polygon points="19 20 9 12 19 4 19 20"/>
                            <line x1="5" y1="19" x2="5" y2="5"/>
                          </svg>
                        </button>
                        <button onClick={() => pressKey('PLAY_PAUSE')} className="p-5 bg-blue-600 hover:bg-blue-700 text-white rounded-full transition shadow-lg" title="Play/Pause">
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polygon points="5 3 19 12 5 21 5 3"/>
                          </svg>
                        </button>
                        <button onClick={() => pressKey('NEXT_TRACK')} className="p-4 bg-slate-700 hover:bg-slate-600 text-white rounded-full transition" title="Next">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polygon points="5 4 15 12 5 20 5 4"/>
                            <line x1="19" y1="5" x2="19" y2="19"/>
                          </svg>
                        </button>
                      </div>

                      <div className="bg-slate-700 rounded-xl p-4">
                        <div className="flex items-center gap-3 mb-2">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-slate-300">
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
                          </svg>
                          <span className="text-white font-medium">{volume}</span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={volume}
                          onChange={(e) => setVolumeLevel(parseInt(e.target.value))}
                          className="w-full h-2 bg-slate-600 rounded-lg appearance-none cursor-pointer"
                          style={{
                            background: \`linear-gradient(to right, #3b82f6 0%, #3b82f6 \${volume}%, #475569 \${volume}%, #475569 100%)\`
                          }}
                        />
                      </div>

                      {presets.length > 0 && (
                        <div>
                          <h3 className="text-slate-300 font-medium mb-3">Presets</h3>
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                            {presets.map((preset) => (
                              <button
                                key={preset.id}
                                onClick={() => selectPreset(preset.id)}
                                className="px-4 py-3 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition text-sm font-medium truncate"
                              >
                                {preset.name}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        }

        ReactDOM.render(<BoseSoundTouchController />, document.getElementById('root'));
    </script>
</body>
</html>`;
