function BoseSoundTouchController() {
          const [selectedSpeaker, setSelectedSpeaker] = useState(null);
          const [groupedSpeakers, setGroupedSpeakers] = useState([]);
          const [volume, setVolume] = useState(50);
          const [isMuted, setIsMuted] = useState(false);
          const [nowPlaying, setNowPlaying] = useState(null);
          const [playStatus, setPlayStatus] = useState(null);
          const [presets, setPresets] = useState([]);
          const [loading, setLoading] = useState(false);
          const [showGroupModal, setShowGroupModal] = useState(false);
          const [zoneError, setZoneError] = useState(null);
          const [showSourcesModal, setShowSourcesModal] = useState(false);
          const [showDebug, setShowDebug] = useState(false);
          const [apiCallHistory, setApiCallHistory] = useState([]);
          const [bassCapabilities, setBassCapabilities] = useState(null);
          const [bass, setBassValue] = useState(0);
          const [shuffleOn, setShuffleOn] = useState(false);
          const [repeatMode, setRepeatMode] = useState('REPEAT_OFF');
          const [sources, setSources] = useState([]);
          const [wsConnected, setWsConnected] = useState(false);
          const [trackPosition, setTrackPosition] = useState(0);
          const wsRef = useRef(null);
          const wsReconnectTimer = useRef(null);
          const volumeDebounceTimer = useRef(null);
          const bassDebounceTimer = useRef(null);
          const positionTimerRef = useRef(null);
          const [zoneVolumes, setZoneVolumes] = useState({});
          const zoneVolumeTimers = useRef({});
          const [zoneMasterIp, setZoneMasterIp] = useState(null);
          const [deviceIds, setDeviceIds] = useState({});

          // ── Core API ───────────────────────────────────────────────────────────
          const sendCommand = async (speaker, endpoint, method = 'GET', body = null) => {
            try {
              const response = await fetch('/api/' + speaker.ip + endpoint, {
                method,
                headers: body ? { 'Content-Type': 'application/xml' } : {},
                body
              });
              const text = await response.text();
              if (!endpoint.includes('/now_playing') && !endpoint.includes('/volume')) {
                setApiCallHistory(prev => [{
                  url: 'http://' + speaker.ip + ':8090' + endpoint,
                  method, body: body || '(none)', response: text,
                  timestamp: new Date().toLocaleTimeString()
                }, ...prev.slice(0, 29)]);
              }
              return text;
            } catch (err) {
              console.error('sendCommand error:', err.message);
              return null;
            }
          };

          const sendGroupCommand = async (endpoint, method = 'GET', body = null) => {
            if (!selectedSpeaker) return;
            const all = groupedSpeakers.length > 0 ? [selectedSpeaker, ...groupedSpeakers] : [selectedSpeaker];
            return Promise.all(all.map(s => sendCommand(s, endpoint, method, body)));
          };

          // ── Fetch helpers ──────────────────────────────────────────────────────
          const fetchVolume = async (speaker) => {
            const spk = speaker || selectedSpeaker;
            if (!spk) return;
            const res = await sendCommand(spk, '/volume');
            if (!res) return;
            const xml = new DOMParser().parseFromString(res, 'text/xml');
            const actual = xml.querySelector('actualvolume')?.textContent;
            const muted = xml.querySelector('muteenabled')?.textContent;
            if (actual) setVolume(parseInt(actual));
            setIsMuted(muted === 'true');
          };

          const fetchNowPlaying = async (speaker) => {
            const spk = speaker || selectedSpeaker;
            if (!spk) return;
            const res = await sendCommand(spk, '/now_playing');
            if (!res) return;
            const xml = new DOMParser().parseFromString(res, 'text/xml');
            const npEl = xml.querySelector('nowPlaying');
            setPlayStatus(xml.querySelector('playStatus')?.textContent || null);
            setTrackPosition(parseInt(xml.querySelector('time')?.textContent || '0'));
            setNowPlaying({
              artist: xml.querySelector('artist')?.textContent || '',
              track: xml.querySelector('track')?.textContent || '',
              album: xml.querySelector('album')?.textContent || '',
              source: npEl?.getAttribute('source') || '',
              sourceAccount: npEl?.getAttribute('sourceAccount') || '',
              stationName: xml.querySelector('stationName')?.textContent ||
                           xml.querySelector('ContentItem itemName')?.textContent || '',
              art: xml.querySelector('art')?.textContent || '',
              description: xml.querySelector('description')?.textContent || '',
              duration: parseInt(xml.querySelector('time')?.getAttribute('total') || '0'),
            });
          };

          const fetchPresets = async (speaker) => {
            const spk = speaker || selectedSpeaker;
            if (!spk) return;
            const res = await sendCommand(spk, '/presets');
            if (!res) return;
            const xml = new DOMParser().parseFromString(res, 'text/xml');
            setPresets(Array.from(xml.querySelectorAll('preset')).map(p => ({
              id: p.getAttribute('id'),
              name: p.querySelector('ContentItem itemName')?.textContent || '',
              source: p.querySelector('ContentItem')?.getAttribute('source') || ''
            })).filter(p => p.name));
          };

          const fetchBassCapabilities = async (speaker) => {
            const spk = speaker || selectedSpeaker;
            if (!spk) return;
            const res = await sendCommand(spk, '/bassCapabilities');
            if (!res) return;
            const xml = new DOMParser().parseFromString(res, 'text/xml');
            if (xml.querySelector('bassAvailable')?.textContent === 'true') {
              const caps = {
                min: parseInt(xml.querySelector('bassMin')?.textContent || '-9'),
                max: parseInt(xml.querySelector('bassMax')?.textContent || '0')
              };
              setBassCapabilities(caps);
              const bassRes = await sendCommand(spk, '/bass');
              if (bassRes) {
                const bxml = new DOMParser().parseFromString(bassRes, 'text/xml');
                const actual = bxml.querySelector('actualbass')?.textContent;
                if (actual) setBassValue(parseInt(actual));
              }
            } else {
              setBassCapabilities(null);
            }
          };

          const fetchSources = async (speaker) => {
            const spk = speaker || selectedSpeaker;
            if (!spk) return;
            const res = await sendCommand(spk, '/sources');
            if (!res) return;
            const xml = new DOMParser().parseFromString(res, 'text/xml');
            setSources(Array.from(xml.querySelectorAll('sourceItem'))
              .filter(s => s.getAttribute('status') === 'READY')
              .map(s => ({
                source: s.getAttribute('source'),
                sourceAccount: s.getAttribute('sourceAccount') || '',
                name: s.textContent.trim() || s.getAttribute('source')
              }))
              .filter(s => s.source && s.source !== 'INVALID_SOURCE'));
          };

          const fetchZoneVolumes = async (selected, grouped) => {
            const all = [selected, ...(grouped || [])];
            const results = await Promise.all(all.map(async (spk) => {
              const res = await sendCommand(spk, '/volume');
              if (!res) return null;
              const xml = new DOMParser().parseFromString(res, 'text/xml');
              const actual = xml.querySelector('actualvolume')?.textContent;
              return actual ? { ip: spk.ip, volume: parseInt(actual) } : null;
            }));
            const vols = {};
            results.filter(Boolean).forEach(r => { vols[r.ip] = r.volume; });
            setZoneVolumes(vols);
          };

          const setZoneMemberVolume = (speaker, level) => {
            setZoneVolumes(prev => ({ ...prev, [speaker.ip]: level }));
            clearTimeout(zoneVolumeTimers.current[speaker.ip]);
            zoneVolumeTimers.current[speaker.ip] = setTimeout(() => {
              sendCommand(speaker, '/volume', 'POST', '<volume>' + level + '</volume>');
            }, 250);
          };

          const removeFromZone = async (spk) => {
            const masterDeviceId = await getDeviceId(selectedSpeaker);
            const slaveDeviceId = await getDeviceId(spk);
            if (!masterDeviceId || !slaveDeviceId) return;
            const xml = '<?xml version="1.0" encoding="UTF-8"?>' +
              '<zone master="' + masterDeviceId + '">' +
              '<member ipaddress="' + spk.ip + '">' + slaveDeviceId + '</member>' +
              '</zone>';
            await sendCommand(selectedSpeaker, '/removeZoneSlave', 'POST', xml);
            setGroupedSpeakers(prev => prev.filter(s => s.ip !== spk.ip));
          };

          const detectAndRestoreZone = async (speaker) => {
            const res = await sendCommand(speaker, '/getZone');
            if (!res) return;
            const xml = new DOMParser().parseFromString(res, 'text/xml');
            const zoneEl = xml.querySelector('zone');
            if (!zoneEl) return;
            const masterIp = zoneEl.getAttribute('senderIPAddress') || '';
            const memberEls = Array.from(zoneEl.querySelectorAll('member'));
            if (!masterIp && memberEls.length === 0) return;
            const slaveIps = memberEls.map(m => m.getAttribute('ipaddress')).filter(Boolean);
            // Build full zone IP list: master + slaves
            const allZoneIps = masterIp ? [masterIp, ...slaveIps] : slaveIps;
            // Speakers in zone other than the one we selected
            const otherIps = allZoneIps.filter(ip => ip !== speaker.ip);
            const otherSpeakers = otherIps.map(ip => SPEAKERS.find(s => s.ip === ip)).filter(Boolean);
            if (otherSpeakers.length === 0) return;
            // Cache device IDs from the zone response — avoids needing /info calls later
            const cached = {};
            const masterId = zoneEl.getAttribute('master');
            if (masterId && masterIp) cached[masterIp] = masterId;
            memberEls.forEach(m => {
              const ip = m.getAttribute('ipaddress');
              const id = m.textContent.trim();
              if (ip && id) cached[ip] = id;
            });
            setDeviceIds(prev => ({ ...prev, ...cached }));
            // Track who the master is (null = selectedSpeaker is the master)
            const isMaster = !masterIp || masterIp === speaker.ip;
            setZoneMasterIp(isMaster ? null : masterIp);
            setGroupedSpeakers(otherSpeakers);
            await fetchZoneVolumes(speaker, otherSpeakers);
          };

          // ── WebSocket ──────────────────────────────────────────────────────────
          const connectWebSocket = (speaker) => {
            if (wsRef.current) {
              wsRef.current.onclose = null;
              wsRef.current.close();
            }
            clearTimeout(wsReconnectTimer.current);

            try {
              const ws = new WebSocket('ws://' + window.location.host + '/ws/' + speaker.ip);
              wsRef.current = ws;

              ws.onopen = () => setWsConnected(true);

              ws.onmessage = (event) => {
                try {
                  const xml = new DOMParser().parseFromString(event.data, 'text/xml');
                  if (xml.querySelector('nowPlayingUpdated')) fetchNowPlaying(speaker);
                  if (xml.querySelector('volumeUpdated')) fetchVolume(speaker);
                  if (xml.querySelector('presetsUpdated')) fetchPresets(speaker);
                } catch (e) {}
              };

              ws.onerror = () => ws.close();
              ws.onclose = () => {
                setWsConnected(false);
                wsReconnectTimer.current = setTimeout(() => connectWebSocket(speaker), 5000);
              };
            } catch (e) {
              console.error('WebSocket failed:', e);
            }
          };

          // ── Speaker selection ──────────────────────────────────────────────────
          const selectSpeaker = async (speaker) => {
            if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
            clearTimeout(wsReconnectTimer.current);
            setWsConnected(false);
            setSelectedSpeaker(speaker);
            setGroupedSpeakers([]);
            setZoneVolumes({});
            setZoneMasterIp(null);
            setLoading(true);
            setBassCapabilities(null);
            setShuffleOn(false);
            setRepeatMode('REPEAT_OFF');
            setNowPlaying(null);
            setPlayStatus(null);

            await Promise.all([
              fetchVolume(speaker),
              fetchNowPlaying(speaker),
              fetchPresets(speaker),
              fetchBassCapabilities(speaker),
              fetchSources(speaker),
            ]);
            await detectAndRestoreZone(speaker);

            connectWebSocket(speaker);
            setLoading(false);
          };

          const disconnectSpeaker = () => {
            if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
            clearTimeout(wsReconnectTimer.current);
            setSelectedSpeaker(null);
            setGroupedSpeakers([]);
            setZoneVolumes({});
            setZoneMasterIp(null);
            setNowPlaying(null);
            setPlayStatus(null);
            setPresets([]);
            setSources([]);
            setBassCapabilities(null);
            setWsConnected(false);
          };

          // ── Playback controls ──────────────────────────────────────────────────
          const pressKey = async (key) => {
            const xml = '<key state="press" sender="Gabbo">' + key + '</key>';
            await sendGroupCommand('/key', 'POST', xml);
            setTimeout(() => sendGroupCommand('/key', 'POST', '<key state="release" sender="Gabbo">' + key + '</key>'), 100);
            if (key === 'PLAY_PAUSE' || key === 'PLAY' || key === 'PAUSE' || key === 'STOP') {
              setTimeout(() => fetchNowPlaying(), 600);
            }
          };

          const setVolumeLevel = (level) => {
            setVolume(level);
            clearTimeout(volumeDebounceTimer.current);
            volumeDebounceTimer.current = setTimeout(() => {
              sendGroupCommand('/volume', 'POST', '<volume>' + level + '</volume>');
            }, 250);
          };

          const toggleMute = async () => {
            const newMuted = !isMuted;
            await sendGroupCommand('/volume', 'POST',
              '<volume>' + volume + '<muteenabled>' + newMuted + '</muteenabled></volume>');
            setIsMuted(newMuted);
          };

          const setBassLevel = (level) => {
            setBassValue(level);
            clearTimeout(bassDebounceTimer.current);
            bassDebounceTimer.current = setTimeout(() => {
              sendCommand(selectedSpeaker, '/bass', 'POST', '<bass>' + level + '</bass>');
            }, 250);
          };

          const selectPreset = async (presetId) => {
            const xml = '<key state="press" sender="Gabbo">PRESET_' + presetId + '</key>';
            await sendGroupCommand('/key', 'POST', xml);
            setTimeout(() => sendGroupCommand('/key', 'POST',
              '<key state="release" sender="Gabbo">PRESET_' + presetId + '</key>'), 100);
            setTimeout(() => fetchNowPlaying(), 1000);
          };

          const switchSource = async (src) => {
            if (!selectedSpeaker) return;
            let xml = '<ContentItem source="' + src.source + '"';
            if (src.sourceAccount) xml += ' sourceAccount="' + src.sourceAccount + '"';
            xml += '></ContentItem>';
            await sendCommand(selectedSpeaker, '/select', 'POST', xml);
            setShowSourcesModal(false);
            setTimeout(() => fetchNowPlaying(), 1000);
          };

          const toggleShuffle = async () => {
            const next = shuffleOn ? 'SHUFFLE_OFF' : 'SHUFFLE_ON';
            await pressKey(next);
            setShuffleOn(!shuffleOn);
          };

          const cycleRepeat = async () => {
            const idx = REPEAT_CYCLE.indexOf(repeatMode);
            const next = REPEAT_CYCLE[(idx + 1) % REPEAT_CYCLE.length];
            await pressKey(next);
            setRepeatMode(next);
          };

          // ── Zone management ────────────────────────────────────────────────────
          const getDeviceId = async (speaker) => {
            if (deviceIds[speaker.ip]) return deviceIds[speaker.ip];
            const res = await sendCommand(speaker, '/info');
            if (!res) return null;
            const xml = new DOMParser().parseFromString(res, 'text/xml');
            const id = xml.querySelector('info')?.getAttribute('deviceID') || null;
            if (id) setDeviceIds(prev => ({ ...prev, [speaker.ip]: id }));
            return id;
          };

          const applyZone = async () => {
            setZoneError(null);
            const masterDeviceId = await getDeviceId(selectedSpeaker);
            if (!masterDeviceId) {
              setZoneError('Could not reach ' + selectedSpeaker.name);
              return;
            }
            if (groupedSpeakers.length === 0) {
              const xml = '<?xml version="1.0" encoding="UTF-8"?><zone master="' + masterDeviceId + '"/>';
              await sendCommand(selectedSpeaker, '/removeZoneSlave', 'POST', xml);
              setShowGroupModal(false);
              return;
            }
            const slaveData = (await Promise.all(
              groupedSpeakers.map(async s => {
                const id = await getDeviceId(s);
                return id ? { speaker: s, deviceId: id } : null;
              })
            )).filter(Boolean);
            if (slaveData.length === 0) {
              setZoneError('Could not reach any selected speakers — are they on?');
              return;
            }
            const membersXml = slaveData.map(s =>
              '<member ipaddress="' + s.speaker.ip + '">' + s.deviceId + '</member>'
            ).join('');
            const xml = '<?xml version="1.0" encoding="UTF-8"?>' +
              '<zone master="' + masterDeviceId + '" senderIPAddress="' + selectedSpeaker.ip + '">' +
              membersXml + '</zone>';
            await sendCommand(selectedSpeaker, '/setZone', 'POST', xml);
            setShowGroupModal(false);
          };

          const toggleGroupSpeaker = (speaker) => {
            setGroupedSpeakers(prev => {
              const in_ = prev.some(s => s.ip === speaker.ip);
              return in_ ? prev.filter(s => s.ip !== speaker.ip) : [...prev, speaker];
            });
          };

          // ── Polling fallback (refreshes now-playing every 15s) ────────────────
          useEffect(() => {
            if (!selectedSpeaker) return;
            const interval = setInterval(() => fetchNowPlaying(), 15000);
            return () => clearInterval(interval);
          }, [selectedSpeaker?.ip]);

          // ── Cleanup ────────────────────────────────────────────────────────────
          useEffect(() => () => {
            if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
            clearTimeout(wsReconnectTimer.current);
            clearTimeout(volumeDebounceTimer.current);
            clearTimeout(bassDebounceTimer.current);
          }, []);

          // ── Derived ────────────────────────────────────────────────────────────
          const isPlaying = playStatus === 'PLAY_STATE';
          const isBuffering = playStatus === 'BUFFERING_STATE';

          const formatTime = (s) => {
            const secs = Math.max(0, Math.floor(s));
            return Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
          };

          useEffect(() => {
            clearInterval(positionTimerRef.current);
            if (isPlaying) {
              positionTimerRef.current = setInterval(() => {
                setTrackPosition(p => p + 1);
              }, 1000);
            }
            return () => clearInterval(positionTimerRef.current);
          }, [isPlaying, nowPlaying?.track]);

          // ── Render ─────────────────────────────────────────────────────────────
          return (
            <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-4">
              <div className="max-w-2xl mx-auto">
                <div className="bg-slate-800 rounded-2xl shadow-2xl overflow-hidden border border-slate-700">

                  {/* Header */}
                  <div className="bg-gradient-to-r from-blue-700 to-blue-600 p-5 flex items-center justify-between">
                    <div>
                      <h1 className="text-2xl font-bold text-white">SoundTouch Control</h1>
                      <p className="text-blue-200 text-xs mt-0.5">Multi-room audio</p>
                    </div>
                    {selectedSpeaker && (
                      <div className="flex items-center gap-2">
                        <div
                          className={'w-2 h-2 rounded-full ' + (wsConnected ? 'bg-green-400' : 'bg-yellow-400')}
                          title={wsConnected ? 'Live updates active' : 'Connecting...'}
                        />
                        <span className="text-blue-200 text-xs">{wsConnected ? 'Live' : 'Polling'}</span>
                      </div>
                    )}
                  </div>

                  {/* Speaker picker */}
                  {!selectedSpeaker ? (
                    <div className="p-5">
                      <h2 className="text-lg font-semibold text-white mb-4">Select a Speaker</h2>
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                        {SPEAKERS.map(speaker => (
                          <button key={speaker.ip} onClick={() => selectSpeaker(speaker)}
                            className="p-4 bg-slate-700 hover:bg-slate-600 rounded-xl transition group text-center">
                            <div className="text-blue-400 group-hover:text-blue-300 flex justify-center mb-2">
                              <SpeakerIcon/>
                            </div>
                            <p className="text-white font-medium text-sm">{speaker.name}</p>
                          </button>
                        ))}
                      </div>
                    </div>

                  ) : loading ? (
                    <div className="p-12 text-center text-slate-300">Loading...</div>

                  ) : (
                    <div className="p-5 space-y-4">

                      {/* Speaker bar */}
                      <div className="bg-slate-700 rounded-xl p-4 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="text-blue-400"><SpeakerIcon/></div>
                          <div>
                            <p className="text-white font-semibold">{selectedSpeaker.name}</p>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button onClick={() => { setShowGroupModal(true); setZoneError(null); }}
                            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs transition">
                            {groupedSpeakers.length > 0 ? 'Group (' + (groupedSpeakers.length + 1) + ')' : 'Group'}
                          </button>
                          {sources.length > 0 && (
                            <button onClick={() => setShowSourcesModal(true)}
                              className="px-3 py-1.5 bg-slate-600 hover:bg-slate-500 text-white rounded-lg text-xs transition">
                              Sources
                            </button>
                          )}
                          <button onClick={disconnectSpeaker}
                            className="px-3 py-1.5 bg-slate-600 hover:bg-slate-500 text-white rounded-lg text-xs transition">
                            Change
                          </button>
                        </div>
                      </div>

                      {/* Zone members */}
                      {groupedSpeakers.length > 0 && (
                        <div>
                          <h3 className="text-slate-400 text-xs font-semibold uppercase tracking-wider mb-2 px-1">Zone Members</h3>
                          <div className="space-y-2">
                            {groupedSpeakers.map(spk => {
                              const vol = zoneVolumes[spk.ip] ?? 50;
                              return (
                                <div key={spk.ip} className="bg-slate-700 rounded-xl p-3 flex items-center gap-3">
                                  <div className="text-slate-400 flex-shrink-0"><SpeakerIcon/></div>
                                  <span className="text-white text-sm font-medium w-28 flex-shrink-0">{spk.name}</span>
                                  <input type="range" min="0" max="100" value={vol}
                                    onChange={e => setZoneMemberVolume(spk, parseInt(e.target.value))}
                                    className="flex-1 h-2 rounded-lg appearance-none cursor-pointer"
                                    style={{ background: 'linear-gradient(to right, #3b82f6 0%, #3b82f6 ' + vol + '%, #475569 ' + vol + '%, #475569 100%)' }}
                                  />
                                  <span className="text-white text-sm w-8 text-right">{vol}</span>
                                  <button onClick={() => removeFromZone(spk)}
                                    className="text-slate-500 hover:text-red-400 transition flex-shrink-0" title="Remove from zone">
                                    ✕
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Now playing */}
                      {nowPlaying && (
                        <div className="bg-slate-700 rounded-xl p-5">
                          <div className="flex items-start gap-4">
                            {nowPlaying.art && nowPlaying.art.startsWith('http') && (
                              <img src={nowPlaying.art} key={nowPlaying.art}
                                   alt="Art" className="w-24 h-24 rounded-lg shadow-lg flex-shrink-0"/>
                            )}
                            <div className="flex-1 min-w-0">
                              {/* Source badge */}
                              <div className="flex items-center gap-2 mb-2 flex-wrap">
                                {nowPlaying.source && (
                                  <span className="px-2.5 py-0.5 bg-blue-600 bg-opacity-40 text-blue-300 text-xs font-bold rounded-full uppercase tracking-wide">
                                    {nowPlaying.source}
                                  </span>
                                )}
                                {nowPlaying.sourceAccount && (
                                  <span className="text-slate-400 text-xs truncate max-w-xs">{nowPlaying.sourceAccount}</span>
                                )}
                                {isBuffering && (
                                  <span className="text-yellow-400 text-xs">Buffering...</span>
                                )}
                              </div>
                              {nowPlaying.stationName && (
                                <p className="text-slate-300 text-sm mb-1 truncate">{nowPlaying.stationName}</p>
                              )}
                              <p className="text-xl font-bold text-white truncate">
                                {nowPlaying.track || (nowPlaying.source === 'STANDBY' ? 'Standby' : '—')}
                              </p>
                              {nowPlaying.artist && <p className="text-slate-200 truncate mt-0.5">{nowPlaying.artist}</p>}
                              {nowPlaying.album && <p className="text-slate-400 text-sm truncate">{nowPlaying.album}</p>}
                              {nowPlaying.description && !nowPlaying.track && (
                                <p className="text-slate-400 text-sm truncate mt-0.5">{nowPlaying.description}</p>
                              )}
                            </div>
                          </div>
                          {nowPlaying.duration > 0 && (
                            <div className="flex items-center gap-2 mt-3">
                              <span className="text-slate-400 text-xs tabular-nums w-10 text-right">
                                {formatTime(Math.min(trackPosition, nowPlaying.duration))}
                              </span>
                              <input type="range" min="0" max={nowPlaying.duration}
                                value={Math.min(trackPosition, nowPlaying.duration)}
                                onChange={() => {}}
                                className="flex-1 h-1.5 rounded-full appearance-none"
                                style={{
                                  pointerEvents: 'none',
                                  background: 'linear-gradient(to right, #3b82f6 0%, #3b82f6 ' +
                                    Math.round(Math.min(trackPosition, nowPlaying.duration) / nowPlaying.duration * 100) +
                                    '%, #475569 ' +
                                    Math.round(Math.min(trackPosition, nowPlaying.duration) / nowPlaying.duration * 100) +
                                    '%, #475569 100%)'
                                }}
                              />
                              <span className="text-slate-400 text-xs tabular-nums w-10">
                                -{formatTime(nowPlaying.duration - Math.min(trackPosition, nowPlaying.duration))}
                              </span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Playback controls */}
                      <div className="bg-slate-700 rounded-xl p-4">
                        <div className="flex justify-center items-center gap-2 mb-4">
                          <button onClick={() => pressKey('POWER')}
                            className="p-3 bg-slate-600 hover:bg-slate-500 text-white rounded-full transition" title="Power">
                            <PowerIcon/>
                          </button>
                          <button onClick={() => pressKey('PREV_TRACK')}
                            className="p-3 bg-slate-600 hover:bg-slate-500 text-white rounded-full transition" title="Previous">
                            <PrevIcon/>
                          </button>
                          <button onClick={() => pressKey('PLAY_PAUSE')}
                            className={'p-4 rounded-full transition shadow-lg ' + (isPlaying ? 'bg-blue-500 hover:bg-blue-600' : 'bg-blue-600 hover:bg-blue-700') + ' text-white'}
                            title="Play/Pause">
                            {isPlaying ? <PauseIcon/> : <PlayIcon/>}
                          </button>
                          <button onClick={() => pressKey('NEXT_TRACK')}
                            className="p-3 bg-slate-600 hover:bg-slate-500 text-white rounded-full transition" title="Next">
                            <NextIcon/>
                          </button>
                          <div className="w-px h-8 bg-slate-500 mx-1"/>
                          <button onClick={toggleShuffle}
                            className={'p-3 rounded-full transition ' + (shuffleOn ? 'bg-blue-600 text-white' : 'bg-slate-600 hover:bg-slate-500 text-slate-300')}
                            title="Shuffle">
                            <ShuffleIcon/>
                          </button>
                          <button onClick={cycleRepeat}
                            className={'p-3 rounded-full transition relative ' + (repeatMode !== 'REPEAT_OFF' ? 'bg-blue-600 text-white' : 'bg-slate-600 hover:bg-slate-500 text-slate-300')}
                            title={'Repeat: ' + repeatMode}>
                            <RepeatIcon/>
                            {repeatMode === 'REPEAT_ONE' && (
                              <span className="absolute -top-1 -right-1 bg-white text-blue-600 text-xs font-bold rounded-full w-4 h-4 flex items-center justify-center leading-none">1</span>
                            )}
                          </button>
                        </div>

                        {/* Volume */}
                        <div className="flex items-center gap-3">
                          <button onClick={toggleMute}
                            className={'p-2 rounded-lg transition ' + (isMuted ? 'text-red-400 bg-red-900 bg-opacity-30' : 'text-slate-300 hover:text-white')}
                            title={isMuted ? 'Unmute' : 'Mute'}>
                            {isMuted ? <MuteIcon size={18}/> : <VolumeIcon size={18}/>}
                          </button>
                          <input type="range" min="0" max="100" value={volume}
                            onChange={e => setVolumeLevel(parseInt(e.target.value))}
                            className="flex-1 h-2 rounded-lg appearance-none cursor-pointer"
                            style={{ background: 'linear-gradient(to right, #3b82f6 0%, #3b82f6 ' + volume + '%, #475569 ' + volume + '%, #475569 100%)' }}
                          />
                          <span className="text-white text-sm w-8 text-right">{isMuted ? '🔇' : volume}</span>
                        </div>
                      </div>

                      {/* Bass */}
                      {bassCapabilities && (
                        <div className="bg-slate-700 rounded-xl p-4">
                          <div className="flex items-center gap-3 mb-2">
                            <div className="text-slate-300"><BassIcon size={18}/></div>
                            <span className="text-slate-300 text-sm font-medium">Bass</span>
                            <span className="text-white text-sm">{bass}</span>
                          </div>
                          <input type="range" min={bassCapabilities.min} max={bassCapabilities.max} value={bass}
                            onChange={e => setBassLevel(parseInt(e.target.value))}
                            className="w-full h-2 bg-slate-600 rounded-lg appearance-none cursor-pointer"
                            style={{ background: 'linear-gradient(to right, #3b82f6 0%, #3b82f6 ' +
                              Math.round(((bass - bassCapabilities.min) / (bassCapabilities.max - bassCapabilities.min)) * 100) +
                              '%, #475569 ' +
                              Math.round(((bass - bassCapabilities.min) / (bassCapabilities.max - bassCapabilities.min)) * 100) +
                              '%, #475569 100%)' }}
                          />
                        </div>
                      )}

                      {/* Presets */}
                      {presets.length > 0 && (
                        <div>
                          <h3 className="text-slate-400 text-xs font-semibold uppercase tracking-wider mb-2 px-1">Presets</h3>
                          <div className="grid grid-cols-2 gap-2">
                            {presets.map(preset => (
                              <button key={preset.id} onClick={() => selectPreset(preset.id)}
                                className="px-4 py-3 bg-slate-700 hover:bg-slate-600 text-white rounded-xl transition text-sm font-medium truncate text-left">
                                {preset.name}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Debug toggle */}
                      <div className="text-center">
                        <button onClick={() => setShowDebug(!showDebug)}
                          className="text-slate-500 hover:text-slate-400 text-xs transition">
                          {showDebug ? 'Hide' : 'Show'} API log ({apiCallHistory.length})
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* API debug panel */}
                {showDebug && apiCallHistory.length > 0 && (
                  <div className="mt-4 bg-slate-900 rounded-xl p-4 border border-slate-700">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-slate-300 font-medium text-sm">API Log</h3>
                      <button onClick={() => setApiCallHistory([])}
                        className="px-2 py-1 bg-red-700 hover:bg-red-800 text-white text-xs rounded transition">
                        Clear
                      </button>
                    </div>
                    <div className="max-h-80 overflow-y-auto space-y-3">
                      {apiCallHistory.map((call, idx) => (
                        <div key={idx} className={idx > 0 ? 'pt-3 border-t border-slate-800' : ''}>
                          <p className="text-slate-500 text-xs mb-1">{call.timestamp} — {call.method} {call.url}</p>
                          {call.body !== '(none)' && (
                            <pre className="text-slate-400 text-xs bg-slate-800 p-2 rounded overflow-x-auto mb-1">{call.body}</pre>
                          )}
                          <pre className="text-slate-300 text-xs bg-slate-800 p-2 rounded overflow-x-auto max-h-32 overflow-y-auto">{call.response}</pre>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Group modal */}
              {showGroupModal && (
                <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center p-4 z-50"
                     onClick={() => setShowGroupModal(false)}>
                  <div className="bg-slate-800 rounded-2xl p-6 max-w-xl w-full max-h-[85vh] overflow-y-auto border border-slate-700"
                       onClick={e => e.stopPropagation()}>
                    <h2 className="text-xl font-bold text-white mb-1">Manage Zone</h2>
                    <p className="text-slate-400 text-sm mb-4">
                      Master: <span className="text-blue-400 font-medium">{selectedSpeaker.name}</span>
                    </p>

                    <div className="grid grid-cols-2 gap-2 mb-5">
                      {SPEAKERS.filter(s => s.ip !== selectedSpeaker.ip).map(speaker => {
                        const inGroup = groupedSpeakers.some(s => s.ip === speaker.ip);
                        return (
                          <div key={speaker.ip}
                               onClick={() => toggleGroupSpeaker(speaker)}
                               className={'rounded-xl border cursor-pointer transition p-3 flex items-center gap-3 ' +
                                 (inGroup ? 'border-blue-500 bg-blue-600 bg-opacity-20 hover:bg-opacity-30' : 'border-slate-600 bg-slate-700 hover:bg-slate-600')}>
                            <div className={'w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition ' +
                              (inGroup ? 'border-blue-500 bg-blue-500' : 'border-slate-500')}>
                              {inGroup && <span className="text-white text-xs font-bold">✓</span>}
                            </div>
                            <div className={'flex-shrink-0 ' + (inGroup ? 'text-blue-300' : 'text-slate-400')}>
                              <SpeakerIcon size={16}/>
                            </div>
                            <span className={'font-medium text-sm ' + (inGroup ? 'text-white' : 'text-slate-200')}>
                              {speaker.name}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    {zoneError && (
                      <p className="text-red-400 text-xs mb-3 px-1">{zoneError}</p>
                    )}

                    <button onClick={applyZone}
                      className="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition text-sm">
                      {groupedSpeakers.length > 0 ? 'Apply (' + (groupedSpeakers.length + 1) + ' speakers)' : 'Remove Zone'}
                    </button>
                  </div>
                </div>
              )}

              {/* Sources modal */}
              {showSourcesModal && (
                <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center p-4 z-50">
                  <div className="bg-slate-800 rounded-2xl p-6 max-w-sm w-full border border-slate-700">
                    <h2 className="text-xl font-bold text-white mb-4">Switch Source</h2>
                    <div className="space-y-2 mb-4">
                      {sources.map((src, idx) => {
                        const active = nowPlaying && nowPlaying.source === src.source &&
                          (!src.sourceAccount || nowPlaying.sourceAccount === src.sourceAccount);
                        return (
                          <button key={idx} onClick={() => switchSource(src)}
                            className={'w-full px-4 py-3 rounded-xl text-left transition flex items-center gap-3 ' +
                              (active ? 'bg-blue-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-white')}>
                            <div className={active ? 'text-white' : 'text-blue-400'}><SourceIcon size={18}/></div>
                            <div>
                              <p className="font-medium text-sm">{src.name}</p>
                              {src.sourceAccount && <p className={'text-xs ' + (active ? 'text-blue-200' : 'text-slate-400')}>{src.sourceAccount}</p>}
                            </div>
                            {active && <span className="ml-auto text-blue-200 text-xs">Playing</span>}
                          </button>
                        );
                      })}
                    </div>
                    <button onClick={() => setShowSourcesModal(false)}
                      className="w-full px-4 py-2.5 bg-slate-600 hover:bg-slate-500 text-white rounded-lg font-medium transition text-sm">
                      Close
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        }

        ReactDOM.render(<BoseSoundTouchController/>, document.getElementById('root'));
