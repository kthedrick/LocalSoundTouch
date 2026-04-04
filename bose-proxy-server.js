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
          const [selectedSpeakers, setSelectedSpeakers] = useState([]);
          const [primarySpeaker, setPrimarySpeaker] = useState(null);
          const [volume, setVolume] = useState(50);
          const [nowPlaying, setNowPlaying] = useState(null);
          const [presets, setPresets] = useState([]);
          const [loading, setLoading] = useState(false);
          const [groupMode, setGroupMode] = useState(false);

          const sendCommand = async (speaker, endpoint, method = 'GET', body = null) => {
            try {
              const response = await fetch(\`/api/\${speaker.ip}\${endpoint}\`, {
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

          const sendGroupCommand = async (endpoint, method = 'GET', body = null) => {
            const promises = selectedSpeakers.map(speaker => 
              sendCommand(speaker, endpoint, method, body)
            );
            return await Promise.all(promises);
          };

          const toggleSpeakerSelection = (speaker) => {
            if (groupMode) {
              setSelectedSpeakers(prev => {
                const isSelected = prev.some(s => s.ip === speaker.ip);
                if (isSelected) {
                  const newSelection = prev.filter(s => s.ip !== speaker.ip);
                  if (primarySpeaker?.ip === speaker.ip) {
                    setPrimarySpeaker(newSelection[0] || null);
                  }
                  return newSelection;
                } else {
                  const newSelection = [...prev, speaker];
                  if (!primarySpeaker) {
                    setPrimarySpeaker(speaker);
                  }
                  return newSelection;
                }
              });
            } else {
              selectSingleSpeaker(speaker);
            }
          };

          const selectSingleSpeaker = async (speaker) => {
            setSelectedSpeakers([speaker]);
            setPrimarySpeaker(speaker);
            setLoading(true);
            
            await Promise.all([
              fetchVolume(speaker),
              fetchNowPlaying(speaker),
              fetchPresets(speaker)
            ]);
            
            setLoading(false);
          };

          const createZone = async () => {
            if (selectedSpeakers.length < 2 || !primarySpeaker) return;
            
            const masterDeviceId = await getDeviceId(primarySpeaker);
            if (!masterDeviceId) return;

            for (const speaker of selectedSpeakers) {
              if (speaker.ip === primarySpeaker.ip) continue;
              
              const slaveDeviceId = await getDeviceId(speaker);
              if (!slaveDeviceId) continue;

              const xml = \`<?xml version="1.0" encoding="UTF-8"?>
<zone master="\${masterDeviceId}">
  <member ipaddress="\${speaker.ip}">\${slaveDeviceId}</member>
</zone>\`;
              
              await sendCommand(primarySpeaker, '/setZone', 'POST', xml);
            }
            
            alert(\`Zone created with \${primarySpeaker.name} as master!\`);
          };

          const removeZone = async () => {
            if (!primarySpeaker) return;
            
            const xml = \`<?xml version="1.0" encoding="UTF-8"?>
<zone master="" />\`;
            
            await sendCommand(primarySpeaker, '/removeZone', 'POST', xml);
            alert('Zone removed!');
          };

          const getDeviceId = async (speaker) => {
            const response = await sendCommand(speaker, '/info');
            if (!response) return null;
            
            const match = response.match(/<deviceID>(.*?)<\\/deviceID>/);
            return match ? match[1] : null;
          };

          const fetchVolume = async (speaker = primarySpeaker) => {
            if (!speaker) return;
            const response = await sendCommand(speaker, '/volume');
            if (response) {
              const match = response.match(/<actualvolume>(\\d+)<\\/actualvolume>/);
              if (match) setVolume(parseInt(match[1]));
            }
          };

          const fetchNowPlaying = async (speaker = primarySpeaker) => {
            if (!speaker) return;
            const response = await sendCommand(speaker, '/now_playing');
            if (response) {
              const parser = new DOMParser();
              const xml = parser.parseFromString(response, 'text/xml');
              
              setNowPlaying({
                artist: xml.querySelector('artist')?.textContent || 'Unknown Artist',
                track: xml.querySelector('track')?.textContent || 'No track playing',
                album: xml.querySelector('album')?.textContent || '',
                source: xml.querySelector('source')?.textContent || '',
                art: xml.querySelector('art')?.textContent || ''
              });
            }
          };

          const fetchPresets = async (speaker = primarySpeaker) => {
            if (!speaker) return;
            const response = await sendCommand(speaker, '/presets');
            if (response) {
              const parser = new DOMParser();
              const xml = parser.parseFromString(response, 'text/xml');
              const presetNodes = xml.querySelectorAll('preset');
              
              const presetList = Array.from(presetNodes).map(preset => {
                const id = preset.getAttribute('id');
                const itemName = preset.querySelector('ContentItem itemName')?.textContent;
                const source = preset.querySelector('ContentItem')?.getAttribute('source');
                
                return {
                  id: id,
                  name: itemName || \`Preset \${id}\`,
                  source: source || ''
                };
              }).filter(p => p.name && p.name !== \`Preset \${p.id}\`);
              
              setPresets(presetList);
            }
          };

          const setVolumeLevel = async (level) => {
            const xml = \`<volume>\${level}</volume>\`;
            await sendGroupCommand('/volume', 'POST', xml);
            setVolume(level);
          };

          const pressKey = async (key) => {
            const xml = \`<key state="press" sender="Gabbo">\${key}</key>\`;
            await sendGroupCommand('/key', 'POST', xml);
            
            const releaseXml = \`<key state="release" sender="Gabbo">\${key}</key>\`;
            setTimeout(() => sendGroupCommand('/key', 'POST', releaseXml), 100);
            
            setTimeout(() => fetchNowPlaying(), 500);
          };

          const selectPreset = async (presetId) => {
            const xml = \`<key state="press" sender="Gabbo">PRESET_\${presetId}</key>\`;
            await sendGroupCommand('/key', 'POST', xml);
            
            const releaseXml = \`<key state="release" sender="Gabbo">PRESET_\${presetId}</key>\`;
            setTimeout(() => sendGroupCommand('/key', 'POST', releaseXml), 100);
            
            setTimeout(() => fetchNowPlaying(), 1000);
          };

          useEffect(() => {
            if (primarySpeaker) {
              const interval = setInterval(() => fetchNowPlaying(), 5000);
              return () => clearInterval(interval);
            }
          }, [primarySpeaker]);

          const isSelected = (speaker) => selectedSpeakers.some(s => s.ip === speaker.ip);
          const isPrimary = (speaker) => primarySpeaker?.ip === speaker.ip;

          return (
            <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-6">
              <div className="max-w-6xl mx-auto">
                <div className="bg-slate-800 rounded-2xl shadow-2xl overflow-hidden border border-slate-700">
                  <div className="bg-gradient-to-r from-blue-600 to-blue-700 p-6">
                    <h1 className="text-3xl font-bold text-white mb-2">SoundTouch Control</h1>
                    <p className="text-blue-100 text-sm">Multi-room audio management</p>
                  </div>

                  {selectedSpeakers.length === 0 ? (
                    <div className="p-6">
                      <div className="flex items-center justify-between mb-4">
                        <h2 className="text-xl font-semibold text-white">Select Speaker(s)</h2>
                        <button
                          onClick={() => setGroupMode(!groupMode)}
                          className={\`px-4 py-2 rounded-lg text-sm font-medium transition \${
                            groupMode 
                              ? 'bg-blue-600 text-white' 
                              : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                          }\`}
                        >
                          {groupMode ? '✓ Group Mode' : 'Group Mode'}
                        </button>
                      </div>
                      {groupMode && (
                        <p className="text-slate-400 text-sm mb-4">
                          Select multiple speakers to control them together
                        </p>
                      )}
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                        {SPEAKERS.map((speaker) => (
                          <button
                            key={speaker.ip}
                            onClick={() => toggleSpeakerSelection(speaker)}
                            className="p-4 bg-slate-700 hover:bg-slate-600 rounded-xl transition group relative"
                          >
                            <svg className="mx-auto mb-2 text-blue-400 group-hover:text-blue-300" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M11 5L6 9H2v6h4l5 4V5z"/>
                              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
                            </svg>
                            <p className="text-white font-medium text-sm">{speaker.name}</p>
                            <p className="text-slate-400 text-xs mt-1">{speaker.ip.split('.').pop()}</p>
                          </button>
                        ))}
                      </div>
                      {groupMode && selectedSpeakers.length > 0 && (
                        <div className="mt-4 flex gap-2">
                          <button
                            onClick={() => {
                              setGroupMode(false);
                              setLoading(true);
                              Promise.all([
                                fetchVolume(primarySpeaker),
                                fetchNowPlaying(primarySpeaker),
                                fetchPresets(primarySpeaker)
                              ]).then(() => setLoading(false));
                            }}
                            className="flex-1 px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition"
                          >
                            Control {selectedSpeakers.length} Speaker{selectedSpeakers.length > 1 ? 's' : ''}
                          </button>
                          {selectedSpeakers.length > 1 && (
                            <button
                              onClick={createZone}
                              className="px-4 py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition"
                            >
                              Create Zone
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ) : loading ? (
                    <div className="p-12 text-center">
                      <p className="text-slate-300">Loading speaker data...</p>
                    </div>
                  ) : (
                    <div className="p-6 space-y-6">
                      <div className="bg-slate-700 rounded-xl p-4">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-3">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-400">
                              <path d="M11 5L6 9H2v6h4l5 4V5z"/>
                              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
                            </svg>
                            <div>
                              <p className="text-white font-semibold">
                                {selectedSpeakers.length === 1 
                                  ? selectedSpeakers[0].name
                                  : \`\${selectedSpeakers.length} Speakers\`}
                              </p>
                              {selectedSpeakers.length > 1 && (
                                <p className="text-slate-400 text-xs">
                                  Primary: {primarySpeaker?.name}
                                </p>
                              )}
                            </div>
                          </div>
                          <button
                            onClick={() => {
                              setSelectedSpeakers([]);
                              setPrimarySpeaker(null);
                              setNowPlaying(null);
                              setPresets([]);
                            }}
                            className="px-4 py-2 bg-slate-600 hover:bg-slate-500 text-white rounded-lg text-sm transition"
                          >
                            Change
                          </button>
                        </div>
                        {selectedSpeakers.length > 1 && (
                          <div>
                            <div className="flex flex-wrap gap-2 mb-2">
                              {selectedSpeakers.map(speaker => (
                                <span key={speaker.ip} className="px-2 py-1 bg-slate-600 text-slate-200 rounded text-xs">
                                  {speaker.name}
                                </span>
                              ))}
                            </div>
                            <button
                              onClick={removeZone}
                              className="text-xs text-red-400 hover:text-red-300"
                            >
                              Remove Zone
                            </button>
                          </div>
                        )}
                      </div>

                      {nowPlaying && (
                        <div className="bg-slate-700 rounded-xl p-6">
                          <div className="flex items-start gap-6">
                            {nowPlaying.art && (
                              <img src={nowPlaying.art} alt="Album art" className="w-32 h-32 rounded-lg shadow-lg" />
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="text-2xl font-bold text-white mb-2 truncate">
                                {nowPlaying.track}
                              </p>
                              <p className="text-xl text-slate-200 mb-1 truncate">{nowPlaying.artist}</p>
                              <p className="text-lg text-slate-400 mb-3 truncate">{nowPlaying.album}</p>
                              <div className="inline-block px-3 py-1 bg-blue-600 bg-opacity-30 text-blue-300 text-xs font-medium rounded-full uppercase">
                                {nowPlaying.source}
                              </div>
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
