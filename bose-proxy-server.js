// Save as: bose-proxy.js
// Run with: node bose-proxy.js
// Then open: http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');

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
    res.end(getHTMLContent());
    return;
  }

  // Proxy API requests
  if (req.url.startsWith('/api/')) {
    const parts = req.url.split('/');
    const ip = parts[2];
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

function getHTMLContent() {
  return `<!DOCTYPE html>
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
          const [groupedSpeakers, setGroupedSpeakers] = useState([]);
          const [volume, setVolume] = useState(50);
          const [nowPlaying, setNowPlaying] = useState(null);
          const [presets, setPresets] = useState([]);
          const [loading, setLoading] = useState(false);
          const [showGroupModal, setShowGroupModal] = useState(false);
          const [showMediaModal, setShowMediaModal] = useState(false);
          const [mediaItems, setMediaItems] = useState([]);
          const [currentMediaPath, setCurrentMediaPath] = useState('');
          const [lastApiCall, setLastApiCall] = useState(null);
          const [apiCallHistory, setApiCallHistory] = useState([]);

          const sendCommand = async (speaker, endpoint, method = 'GET', body = null) => {
            try {
              const url = '/api/' + speaker.ip + endpoint;
              const response = await fetch(url, {
                method,
                headers: body ? { 'Content-Type': 'application/xml' } : {},
                body
              });
              const responseText = await response.text();
              
              const callInfo = {
                url: 'http://' + speaker.ip + ':8090' + endpoint,
                method: method,
                body: body || '(none)',
                response: responseText,
                timestamp: new Date().toLocaleTimeString()
              };
              
              setLastApiCall(callInfo);
              setApiCallHistory(prev => [callInfo, ...prev].slice(0, 2));
              
              return responseText;
            } catch (error) {
              console.error('Error:', error.message);
              const errorInfo = {
                url: 'http://' + speaker.ip + ':8090' + endpoint,
                method: method,
                body: body || '(none)',
                response: 'ERROR: ' + error.message,
                timestamp: new Date().toLocaleTimeString()
              };
              setLastApiCall(errorInfo);
              setApiCallHistory(prev => [errorInfo, ...prev].slice(0, 2));
              return null;
            }
          };

          const sendGroupCommand = async (endpoint, method = 'GET', body = null) => {
            const speakers = groupedSpeakers.length > 0 ? [selectedSpeaker, ...groupedSpeakers] : [selectedSpeaker];
            const promises = speakers.map(speaker => 
              sendCommand(speaker, endpoint, method, body)
            );
            return await Promise.all(promises);
          };

          const selectSpeaker = async (speaker) => {
            setSelectedSpeaker(speaker);
            setGroupedSpeakers([]);
            setLoading(true);
            
            await Promise.all([
              fetchVolume(speaker),
              fetchNowPlaying(speaker),
              fetchPresets(speaker)
            ]);
            
            setLoading(false);
          };

          const toggleGroupSpeaker = (speaker) => {
            setGroupedSpeakers(prev => {
              const isGrouped = prev.some(s => s.ip === speaker.ip);
              if (isGrouped) {
                return prev.filter(s => s.ip !== speaker.ip);
              } else {
                return [...prev, speaker];
              }
            });
          };

          const createZone = async () => {
            if (groupedSpeakers.length === 0) return;
            
            try {
              const masterInfo = await sendCommand(selectedSpeaker, '/info');
              console.log('Master info:', masterInfo);
              
              if (!masterInfo) {
                alert('Could not connect to master speaker: ' + selectedSpeaker.name);
                return;
              }

              const deviceIdRegex = new RegExp('<deviceID>([^<]+)</deviceID>', 'i');
              const masterIdMatch = masterInfo.match(deviceIdRegex);
              
              if (!masterIdMatch) {
                alert('Could not find device ID in master speaker response. Check console for details.');
                console.error('Master response:', masterInfo);
                return;
              }
              
              const masterDeviceId = masterIdMatch[1];
              console.log('Master ID:', masterDeviceId);

              let successCount = 0;
              for (const speaker of groupedSpeakers) {
                const slaveInfo = await sendCommand(speaker, '/info');
                if (!slaveInfo) {
                  console.error('Could not get info from:', speaker.name);
                  continue;
                }

                const slaveIdMatch = slaveInfo.match(deviceIdRegex);
                if (!slaveIdMatch) {
                  console.error('Could not find device ID for:', speaker.name);
                  continue;
                }
                
                const slaveDeviceId = slaveIdMatch[1];
                console.log('Adding to zone:', speaker.name, slaveDeviceId);

                const xml = '<?xml version="1.0" encoding="UTF-8"?>' +
                  '<zone master="' + masterDeviceId + '">' +
                  '<member ipaddress="' + speaker.ip + '">' + slaveDeviceId + '</member>' +
                  '</zone>';
                
                const result = await sendCommand(selectedSpeaker, '/setZone', 'POST', xml);
                console.log('Zone creation result:', result);
                successCount++;
              }
              
              setShowGroupModal(false);
              if (successCount > 0) {
                alert('Zone created! ' + selectedSpeaker.name + ' is controlling ' + successCount + ' speaker(s).');
              } else {
                alert('Failed to add any speakers to the zone. Check console for details.');
              }
            } catch (error) {
              console.error('Zone creation error:', error);
              alert('Error creating zone: ' + error.message);
            }
          };

          const removeZone = async () => {
            const xml = '<?xml version="1.0" encoding="UTF-8"?><zone />';
            await sendCommand(selectedSpeaker, '/removeZone', 'POST', xml);
            
            for (const speaker of groupedSpeakers) {
              await sendCommand(speaker, '/removeZone', 'POST', xml);
            }
            
            setGroupedSpeakers([]);
            alert('Zone removed!');
          };

          const fetchVolume = async (speaker = selectedSpeaker) => {
            if (!speaker) return;
            const response = await sendCommand(speaker, '/volume');
            if (response) {
              const volumeRegex = new RegExp('<actualvolume>(\\\\d+)</actualvolume>');
              const match = response.match(volumeRegex);
              if (match) setVolume(parseInt(match[1]));
            }
          };

          const fetchNowPlaying = async (speaker = selectedSpeaker) => {
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

          const fetchPresets = async (speaker = selectedSpeaker) => {
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
                  name: itemName || 'Preset ' + id,
                  source: source || ''
                };
              }).filter(p => p.name && p.name !== 'Preset ' + p.id);
              
              setPresets(presetList);
            }
          };

          const browseMedia = async (location = '') => {
            if (!selectedSpeaker) return;
            
            const xml = '<ContentItem source="STORED_MUSIC" type="dir" location="' + location + '" sourceAccount="4d696e69-444c-164e-9d41-c46e1faa21b9/0"><itemName>Music Library</itemName></ContentItem>';
            const response = await sendCommand(selectedSpeaker, '/browse', 'POST', xml);
            
            if (response) {
              const parser = new DOMParser();
              const xml = parser.parseFromString(response, 'text/xml');
              const items = xml.querySelectorAll('item');
              
              const mediaList = Array.from(items).map(item => ({
                name: item.querySelector('itemName')?.textContent || 'Unknown',
                type: item.getAttribute('type'),
                location: item.getAttribute('location') || '',
                source: item.getAttribute('source'),
                sourceAccount: item.getAttribute('sourceAccount') || ''
              }));
              
              setMediaItems(mediaList);
              setCurrentMediaPath(location);
            }
          };

          const playMedia = async (item) => {
            const sourceAccount = item.sourceAccount || '4d696e69-444c-164e-9d41-c46e1faa21b9/0';
            const xml = '<ContentItem source="' + item.source + '" type="' + item.type + '" location="' + item.location + '" sourceAccount="' + sourceAccount + '"><itemName>' + item.name + '</itemName></ContentItem>';
            await sendGroupCommand('/select', 'POST', xml);
            setShowMediaModal(false);
            setTimeout(() => fetchNowPlaying(), 1000);
          };

          const navigateMedia = async (item) => {
            if (item.type === 'dir') {
              await browseMedia(item.location);
            } else {
              await playMedia(item);
            }
          };

          const setVolumeLevel = async (level) => {
            const xml = '<volume>' + level + '</volume>';
            await sendGroupCommand('/volume', 'POST', xml);
            setVolume(level);
          };

          const pressKey = async (key) => {
            const xml = '<key state="press" sender="Gabbo">' + key + '</key>';
            await sendGroupCommand('/key', 'POST', xml);
            
            const releaseXml = '<key state="release" sender="Gabbo">' + key + '</key>';
            setTimeout(() => sendGroupCommand('/key', 'POST', releaseXml), 100);
            
            setTimeout(() => fetchNowPlaying(), 500);
          };

          const selectPreset = async (presetId) => {
            const xml = '<key state="press" sender="Gabbo">PRESET_' + presetId + '</key>';
            await sendGroupCommand('/key', 'POST', xml);
            
            const releaseXml = '<key state="release" sender="Gabbo">PRESET_' + presetId + '</key>';
            setTimeout(() => sendGroupCommand('/key', 'POST', releaseXml), 100);
            
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
                            <p className="text-slate-400 text-xs mt-1">{speaker.ip.split('.').pop()}</p>
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
                      <div className="bg-slate-700 rounded-xl p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-400">
                              <path d="M11 5L6 9H2v6h4l5 4V5z"/>
                              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
                            </svg>
                            <div>
                              <p className="text-white font-semibold">{selectedSpeaker.name}</p>
                              {groupedSpeakers.length > 0 && (
                                <p className="text-slate-400 text-xs">
                                  + {groupedSpeakers.length} grouped speaker{groupedSpeakers.length > 1 ? 's' : ''}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => setShowGroupModal(true)}
                              className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm transition"
                            >
                              {groupedSpeakers.length > 0 ? 'Manage Group' : 'Add to Group'}
                            </button>
                            <button
                              onClick={() => {
                                setSelectedSpeaker(null);
                                setGroupedSpeakers([]);
                                setNowPlaying(null);
                                setPresets([]);
                              }}
                              className="px-3 py-2 bg-slate-600 hover:bg-slate-500 text-white rounded-lg text-sm transition"
                            >
                              Change
                            </button>
                          </div>
                        </div>
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
                            background: 'linear-gradient(to right, #3b82f6 0%, #3b82f6 ' + volume + '%, #475569 ' + volume + '%, #475569 100%)'
                          }}
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        {presets.length > 0 && (
                          <div>
                            <h3 className="text-slate-300 font-medium mb-3">Presets</h3>
                            <div className="grid grid-cols-1 gap-2">
                              {presets.slice(0, 4).map((preset) => (
                                <button
                                  key={preset.id}
                                  onClick={() => selectPreset(preset.id)}
                                  className="px-4 py-3 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition text-sm font-medium truncate text-left"
                                >
                                  {preset.name}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        <div>
                          <h3 className="text-slate-300 font-medium mb-3">Stored Music</h3>
                          <button
                            onClick={() => {
                              setShowMediaModal(true);
                              browseMedia('');
                            }}
                            className="w-full px-4 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition text-sm font-medium"
                          >
                            Browse Library
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {apiCallHistory.length > 0 && (
                  <div className="mt-4 bg-slate-900 rounded-xl p-4 border border-slate-700">
                    <h3 className="text-slate-300 font-medium mb-3 text-sm">Last 2 API Calls</h3>
                    {apiCallHistory.map((call, idx) => (
                      <div key={idx} className={idx > 0 ? 'mt-4 pt-4 border-t border-slate-700' : ''}>
                        <h4 className="text-slate-400 text-xs mb-2">Call #{idx + 1} ({call.timestamp})</h4>
                        <div className="space-y-2 text-xs font-mono">
                          <div>
                            <span className="text-slate-400">Method:</span>
                            <span className="text-blue-400 ml-2">{call.method}</span>
                          </div>
                          <div>
                            <span className="text-slate-400">URL:</span>
                            <span className="text-green-400 ml-2 break-all">{call.url}</span>
                          </div>
                          <div>
                            <span className="text-slate-400">Body:</span>
                            <pre className="text-slate-300 ml-2 mt-1 bg-slate-800 p-2 rounded overflow-x-auto">{call.body}</pre>
                          </div>
                          <div>
                            <span className="text-slate-400">Response:</span>
                            <pre className="text-slate-300 ml-2 mt-1 bg-slate-800 p-2 rounded overflow-x-auto max-h-40 overflow-y-auto">{call.response}</pre>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {showGroupModal && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
                  <div className="bg-slate-800 rounded-2xl p-6 max-w-2xl w-full max-h-[80vh] overflow-y-auto border border-slate-700">
                    <h2 className="text-2xl font-bold text-white mb-4">Group Speakers</h2>
                    <p className="text-slate-300 mb-4">
                      Master: <span className="text-blue-400 font-medium">{selectedSpeaker.name}</span>
                    </p>
                    
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
                      {SPEAKERS.filter(s => s.ip !== selectedSpeaker.ip).map((speaker) => {
                        const isGrouped = groupedSpeakers.some(gs => gs.ip === speaker.ip);
                        return (
                          <button
                            key={speaker.ip}
                            onClick={() => toggleGroupSpeaker(speaker)}
                            className={'p-4 rounded-xl transition ' + (isGrouped ? 'bg-blue-600 hover:bg-blue-700' : 'bg-slate-700 hover:bg-slate-600')}
                          >
                            <svg className={'mx-auto mb-2 ' + (isGrouped ? 'text-white' : 'text-blue-400')} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M11 5L6 9H2v6h4l5 4V5z"/>
                              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
                            </svg>
                            <p className="text-white font-medium text-sm">{speaker.name}</p>
                            {isGrouped && (
                              <p className="text-blue-200 text-xs mt-1">✓ Selected</p>
                            )}
                          </button>
                        );
                      })}
                    </div>

                    <div className="flex gap-3">
                      {groupedSpeakers.length > 0 && (
                        <>
                          <button
                            onClick={createZone}
                            className="flex-1 px-4 py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition"
                          >
                            Create Zone ({groupedSpeakers.length + 1} speakers)
                          </button>
                          <button
                            onClick={removeZone}
                            className="px-4 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition"
                          >
                            Remove Zone
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => setShowGroupModal(false)}
                        className="px-4 py-3 bg-slate-600 hover:bg-slate-500 text-white rounded-lg font-medium transition"
                      >
                        Close
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {showMediaModal && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
                  <div className="bg-slate-800 rounded-2xl p-6 max-w-2xl w-full max-h-[80vh] overflow-y-auto border border-slate-700">
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="text-2xl font-bold text-white">Music Library</h2>
                      {currentMediaPath && (
                        <button
                          onClick={() => browseMedia('')}
                          className="px-3 py-1 bg-slate-600 hover:bg-slate-500 text-white rounded text-sm"
                        >
                          ← Back to Root
                        </button>
                      )}
                    </div>
                    
                    {currentMediaPath && (
                      <p className="text-slate-400 text-sm mb-4">Path: {currentMediaPath || '/'}</p>
                    )}

                    <div className="space-y-2 mb-6">
                      {mediaItems.length === 0 ? (
                        <p className="text-slate-400 text-center py-8">No items found or loading...</p>
                      ) : (
                        mediaItems.map((item, idx) => (
                          <button
                            key={idx}
                            onClick={() => navigateMedia(item)}
                            className="w-full px-4 py-3 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition text-left flex items-center gap-2"
                          >
                            {item.type === 'dir' ? (
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                              </svg>
                            ) : (
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="10"/>
                                <polygon points="10 8 16 12 10 16 10 8"/>
                              </svg>
                            )}
                            <span className="font-medium">{item.name}</span>
                          </button>
                        ))
                      )}
                    </div>

                    <button
                      onClick={() => setShowMediaModal(false)}
                      className="w-full px-4 py-3 bg-slate-600 hover:bg-slate-500 text-white rounded-lg font-medium transition"
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        }

        ReactDOM.render(<BoseSoundTouchController />, document.getElementById('root'));
    </script>
</body>
</html>`;
}
