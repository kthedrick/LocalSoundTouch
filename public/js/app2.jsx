const { useMemo } = React;

// ── API helpers ───────────────────────────────────────────────────────────────
async function apiGet(ip, endpoint) {
  try {
    const res = await fetch('/api/' + ip + endpoint);
    const text = await res.text();
    console.debug('apiGet', ip, endpoint, 'status=', res.status, 'ok=', res.ok, 'body=', text.slice(0, 200));
    return res.ok ? text : null;
  } catch (err) {
    console.warn('apiGet error', ip, endpoint, err);
    return null;
  }
}

async function apiPost(ip, endpoint, body) {
  try {
    console.debug('apiPost', ip, endpoint, body.slice ? body.slice(0, 200) : body);
    await fetch('/api/' + ip + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body,
    });
  } catch (err) {
    console.warn('apiPost error', ip, endpoint, err);
  }
}

async function fetchSpeakerData(spk) {
  const infoRes = await apiGet(spk.ip, '/info');
  if (infoRes === null) {
    return {
      ip: spk.ip,
      name: spk.name,
      volume: 0,
      muted: false,
      nowPlaying: null,
      playStatus: null,
      zoneInfo: null,
      presets: [],
      reachable: false,
      failedCall: 'info',
    };
  }

  const [volRes, npRes, zoneRes, presetRes] = await Promise.all([
    apiGet(spk.ip, '/volume'),
    apiGet(spk.ip, '/now_playing'),
    apiGet(spk.ip, '/getZone'),
    apiGet(spk.ip, '/presets'),
  ]);

  const failedCall = !volRes ? 'volume'
    : !npRes ? 'now_playing'
    : !zoneRes ? 'getZone'
    : !presetRes ? 'presets'
    : null;

  let volume = 0, muted = false;
  if (volRes) {
    const xml = new DOMParser().parseFromString(volRes, 'text/xml');
    volume = parseInt(xml.querySelector('actualvolume')?.textContent || '0');
    muted = xml.querySelector('muteenabled')?.textContent === 'true';
  }

  let nowPlaying = null, playStatus = null;
  if (npRes) {
    const xml = new DOMParser().parseFromString(npRes, 'text/xml');
    const npEl = xml.querySelector('nowPlaying');
    const timeEl = xml.querySelector('time');
    playStatus = xml.querySelector('playStatus')?.textContent || null;
    nowPlaying = {
      source:        npEl?.getAttribute('source') || '',
      sourceAccount: npEl?.getAttribute('sourceAccount') || '',
      track:         xml.querySelector('track')?.textContent || '',
      artist:        xml.querySelector('artist')?.textContent || '',
      album:         xml.querySelector('album')?.textContent || '',
      stationName:   xml.querySelector('stationName')?.textContent ||
                     xml.querySelector('ContentItem itemName')?.textContent || '',
      art:           xml.querySelector('art')?.textContent || '',
      duration:      parseInt(timeEl?.getAttribute('total') || '0'),
      position:      parseInt(timeEl?.textContent || '0'),
    };
  }

  let zoneInfo = null;
  if (zoneRes) {
    const xml = new DOMParser().parseFromString(zoneRes, 'text/xml');
    const zoneEl = xml.querySelector('zone');
    if (zoneEl) {
      let masterIp  = zoneEl.getAttribute('senderIPAddress') || '';
      const memberIps = Array.from(zoneEl.querySelectorAll('member'))
        .map(m => m.getAttribute('ipaddress')).filter(Boolean);
      // If Bose doesn't return senderIPAddress but we have members, infer master is this speaker
      if (!masterIp && memberIps.length > 0) masterIp = spk.ip;
      if (masterIp || memberIps.length > 0) zoneInfo = { masterIp, memberIps };
    }
  }

  let presets = [];
  if (presetRes) {
    const xml = new DOMParser().parseFromString(presetRes, 'text/xml');
    presets = Array.from(xml.querySelectorAll('preset')).map(p => ({
      id: p.getAttribute('id'),
      name: p.querySelector('ContentItem itemName')?.textContent || '',
      source: p.querySelector('ContentItem')?.getAttribute('source') || ''
    })).filter(p => p.name);
  }

  return { ip: spk.ip, name: spk.name, volume, muted, nowPlaying, playStatus, zoneInfo, presets, reachable: true, failedCall };
}

// ── GroupCard ─────────────────────────────────────────────────────────────────
function GroupCard({ group, onVolumeChange, onMute, onKey, onSyncTo, onAddToGroup, onRemoveFromGroup, otherSpeakers, speakerData, groups }) {
  const master   = group.speakers.find(s => s.ip === group.masterIp) || group.speakers[0];
  const np       = master?.nowPlaying;
  const isStandby   = !np || np.source === 'STANDBY';
  const isPlaying   = master?.playStatus === 'PLAY_STATE';
  const hasContent  = !isStandby && (np?.track || np?.stationName || np?.source);

  const [position, setPosition] = useState(np?.position || 0);
  const timerRef = useRef(null);

  useEffect(() => { setPosition(np?.position || 0); }, [np?.track, np?.stationName, np?.source]);

  useEffect(() => {
    clearInterval(timerRef.current);
    if (isPlaying && np?.duration > 0) {
      timerRef.current = setInterval(() => setPosition(p => p + 1), 1000);
    }
    return () => clearInterval(timerRef.current);
  }, [isPlaying, np?.duration, np?.track]);

  const formatTime = (s) => {
    const n = Math.max(0, Math.floor(s));
    return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
  };

  const pos  = Math.min(position, np?.duration || 0);
  const pct  = np?.duration > 0 ? Math.round(pos / np.duration * 100) : 0;

  return (
    <div className="bg-slate-800 rounded-2xl overflow-hidden border border-slate-700">

      {/* ── Now playing ── */}
      {hasContent && (
        <div className="p-4 border-b border-slate-700">
          <div className="flex items-start gap-3">
            {np.art && np.art.startsWith('http') && (
              <img src={np.art} key={np.art} alt="Art"
                   className="w-16 h-16 rounded-lg object-cover flex-shrink-0"/>
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                {np.source && (
                  <span className="px-2 py-0.5 bg-blue-600 bg-opacity-40 text-blue-300 text-xs font-bold rounded-full uppercase tracking-wide">
                    {np.source}
                  </span>
                )}
                {np.sourceAccount && (
                  <span className="text-slate-500 text-xs truncate">{np.sourceAccount}</span>
                )}
              </div>
              {np.stationName && (
                <p className="text-slate-400 text-xs truncate">{np.stationName}</p>
              )}
              <p className="text-white font-semibold truncate leading-tight">
                {np.track || '—'}
              </p>
              {np.artist && (
                <p className="text-slate-300 text-sm truncate">{np.artist}</p>
              )}
            </div>

            {/* Playback controls */}
            <div className="flex items-center gap-1 flex-shrink-0">
              <button onClick={() => onKey(group.masterIp, 'PREV_TRACK')}
                className="p-1.5 text-slate-400 hover:text-white transition rounded-lg hover:bg-slate-700">
                <PrevIcon size={15}/>
              </button>
              <button onClick={() => onKey(group.masterIp, 'PLAY_PAUSE')}
                className="p-1.5 text-slate-400 hover:text-white transition rounded-lg hover:bg-slate-700">
                {isPlaying ? <PauseIcon size={15}/> : <PlayIcon size={15}/>}
              </button>
              <button onClick={() => onKey(group.masterIp, 'NEXT_TRACK')}
                className="p-1.5 text-slate-400 hover:text-white transition rounded-lg hover:bg-slate-700">
                <NextIcon size={15}/>
              </button>
            </div>
          </div>

          {/* Progress bar */}
          {np.duration > 0 && (
            <div className="flex items-center gap-2 mt-2.5">
              <span className="text-slate-500 text-xs tabular-nums w-10 text-right">{formatTime(pos)}</span>
              <div className="flex-1 h-1 bg-slate-700 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full"
                     style={{ width: pct + '%' }}/>
              </div>
              <span className="text-slate-500 text-xs tabular-nums w-10">
                -{formatTime((np.duration || 0) - pos)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── Speakers ── */}
      <div className="divide-y divide-slate-700/60">
        {group.speakers.map(spk => (
          <div key={spk.ip} className="px-4 py-3 sm:py-2.5">
            {/* Speaker header — always full width */}
            <div className="flex items-center gap-2 mb-2 sm:mb-0">
              <div className="text-slate-500 flex-shrink-0"><SpeakerIcon size={15}/></div>
              <div className="flex-1 min-w-0">
                <span className="text-slate-200 text-sm font-medium block">{spk.name}</span>
                <span className="text-slate-500 text-[11px] block">{spk.ip}</span>
              </div>
            </div>

            {/* Volume controls + remove button */}
            <div className="flex items-center gap-2 sm:gap-1 sm:ml-6">
              {!spk.reachable ? (
                <div className="flex items-center gap-2">
                  <span className="text-slate-600 text-xs">Unreachable</span>
                  {spk.failedCall && (
                    <span className="text-rose-400 text-xs">({spk.failedCall})</span>
                  )}
                </div>
              ) : (
                <>
                  <button onClick={() => onMute(spk.ip)}
                    className="p-2 sm:px-2 sm:py-1 bg-slate-600 hover:bg-slate-500 text-white rounded text-xs flex-shrink-0">
                    {spk.muted ? <VolumeIcon size={14}/> : <MuteIcon size={14}/>}
                  </button>
                  <button onClick={() => onVolumeChange(spk.ip, Math.max(0, spk.volume - 1), true)}
                    className="px-2.5 py-2 sm:px-2 sm:py-1 bg-slate-600 hover:bg-slate-500 text-white rounded text-xs font-mono flex-shrink-0">−</button>
                  <input type="range" min="0" max="100" value={spk.volume}
                    onChange={e => onVolumeChange(spk.ip, parseInt(e.target.value))}
                    className="flex-1 sm:w-40 h-2 sm:h-1.5 rounded-full appearance-none cursor-pointer"
                    style={{
                      background: 'linear-gradient(to right, #3b82f6 0%, #3b82f6 ' +
                        spk.volume + '%, #334155 ' + spk.volume + '%, #334155 100%)'
                    }}
                  />
                  <button onClick={() => onVolumeChange(spk.ip, Math.min(100, spk.volume + 1), true)}
                    className="px-2.5 py-2 sm:px-2 sm:py-1 bg-slate-600 hover:bg-slate-500 text-white rounded text-xs font-mono flex-shrink-0">+</button>
                  <span className="text-slate-400 text-xs tabular-nums w-8 text-right flex-shrink-0">{spk.volume}</span>

                  {/* Status badges */}
                  {spk.failedCall && (
                    <span className="text-rose-400 text-[10px] uppercase tracking-[0.08em]">Failed: {spk.failedCall}</span>
                  )}
                  {isStandby && (
                    <span className="text-slate-600 text-xs">Standby</span>
                  )}

                  {/* Remove button */}
                  {group.speakers.length > 1 && (
                    <button onClick={() => onRemoveFromGroup(group.masterIp, spk.ip)}
                      className="p-2 bg-slate-600 hover:bg-red-600 text-white rounded transition flex-shrink-0 flex items-center justify-center w-8 h-8">
                      <span className="text-xl leading-none">×</span>
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Presets */}
      {master.presets && master.presets.length > 0 && (
        <div className="px-4 py-3 border-t border-slate-700/60">
          <h3 className="text-slate-400 text-xs font-semibold uppercase tracking-wider mb-2">Presets</h3>
          <div className="flex gap-1 overflow-x-auto">
            {master.presets.map(preset => (
              <button key={preset.id} onClick={() => onKey(group.masterIp, 'PRESET_' + preset.id)}
                className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded text-xs font-medium truncate whitespace-nowrap flex-shrink-0">
                {preset.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {isStandby && (
        (() => {
          const playingMasters = otherSpeakers.filter(spk => {
            const data = speakerData[spk.ip];
            const masterGroup = groups.find(g => g.masterIp === spk.ip);
            return masterGroup && data?.nowPlaying?.source && data.nowPlaying.source !== 'STANDBY';
          });
          return playingMasters.length > 0 && (
            <div className="px-4 py-3 border-t border-slate-700/60">
              <h3 className="text-slate-400 text-xs font-semibold uppercase tracking-wider mb-2">Sync To</h3>
              <div className="flex flex-wrap gap-2">
                {playingMasters.map(spk => (
                  <button key={spk.ip} onClick={() => onSyncTo(group.speakers[0].ip, spk.ip)}
                    className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded text-xs transition">
                    {spk.name}
                  </button>
                ))}
              </div>
            </div>
          );
        })()
      )}

      {!isStandby && otherSpeakers && otherSpeakers.length > 0 && (
        <div className="px-4 py-3 border-t border-slate-700/60">
          <h3 className="text-slate-400 text-xs font-semibold uppercase tracking-wider mb-2">Include</h3>
          <div className="flex flex-wrap gap-2">
            {otherSpeakers.map(spk => {
              const data = speakerData[spk.ip];
              const isPlaying = data?.nowPlaying?.source && data.nowPlaying.source !== 'STANDBY';
              return (
                <button key={spk.ip} onClick={() => onAddToGroup(group.masterIp, spk.ip)}
                  className={'px-2 py-1 rounded text-xs transition ' +
                    (isPlaying
                      ? 'bg-green-600 hover:bg-green-500 text-white'
                      : 'bg-slate-700 hover:bg-slate-600 text-slate-200'
                    )}>
                  {spk.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── AllSpeakersView ───────────────────────────────────────────────────────────
function AllSpeakersView() {
  const [speakerData, setSpeakerData] = useState({});
  const [speakers, setSpeakers] = useState(SPEAKERS);
  const [loading, setLoading]         = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const volumeTimers = useRef({});
  const deviceIds = useRef({});

  const fetchSpeakers = async () => {
    try {
      const res = await fetch('/speakers');
      if (!res.ok) return SPEAKERS;
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        setSpeakers(data);
        return data;
      }
    } catch (err) {
      console.warn('fetchSpeakers failed', err);
    }
    return SPEAKERS;
  };

  const pollAll = async (list = speakers) => {
    const speakerList = list.length ? list : SPEAKERS;
    const promises = speakerList.map(async (spk) => {
      const data = await fetchSpeakerData(spk);
      setSpeakerData(prev => ({ ...prev, [data.ip]: data }));
    });
    await Promise.all(promises);
    setLastUpdated(new Date());
  };

  useEffect(() => {
    const load = async () => {
      setSpeakerData({});
      const discovered = await fetchSpeakers();
      await pollAll(discovered);
    };

    load();
    const interval = setInterval(async () => {
      const discovered = await fetchSpeakers();
      await pollAll(discovered);
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  const groups = useMemo(() => {
    if (!Object.keys(speakerData).length) return [];

    const speakerList = speakers.length ? speakers : SPEAKERS;

    // Collect zones: masterIp → Set of all IPs in that zone
    const zones = {};
    speakerList.forEach(spk => {
      const z = speakerData[spk.ip]?.zoneInfo;
      if (!z?.masterIp) return;
      if (!zones[z.masterIp]) zones[z.masterIp] = new Set([z.masterIp, ...z.memberIps]);
      else z.memberIps.forEach(ip => zones[z.masterIp].add(ip));
    });

    const allZoneIps = new Set(Object.values(zones).flatMap(s => [...s]));
    const result = [];

    // Zone groups — preserve speakerList order within each zone
    Object.entries(zones).forEach(([masterIp, ipSet]) => {
      const speakersInZone = speakerList
        .filter(s => ipSet.has(s.ip))
        .map(s => speakerData[s.ip])
        .filter(Boolean)
        .sort((a, b) => (a.ip === masterIp ? -1 : b.ip === masterIp ? 1 : 0));
      if (speakersInZone.length) result.push({ id: masterIp, masterIp, speakers: speakersInZone });
    });

    // Standalone speakers
    speakerList.forEach(spk => {
      if (!allZoneIps.has(spk.ip) && speakerData[spk.ip])
        result.push({ id: spk.ip, masterIp: spk.ip, speakers: [speakerData[spk.ip]] });
    });

    // Sort: Sunroom first, then playing first, then paused/stopped, then standby, then unreachable
    const rank = g => {
      const m = g.speakers.find(s => s.ip === g.masterIp) || g.speakers[0];
      if (!m?.reachable)               return 3;
      if (m?.nowPlaying?.source === 'STANDBY' || !m?.nowPlaying) return 2;
      if (m?.playStatus === 'PLAY_STATE') return 0;
      return 1;
    };
    result.sort((a, b) => {
      const aHasSunroom = a.speakers.some(s => s.ip === '192.168.1.229');
      const bHasSunroom = b.speakers.some(s => s.ip === '192.168.1.229');
      if (aHasSunroom && !bHasSunroom) return -1;
      if (!aHasSunroom && bHasSunroom) return 1;
      return rank(a) - rank(b);
    });

    return result;
  }, [speakerData]);

  const getDeviceId = async (ip) => {
    if (deviceIds.current[ip]) return deviceIds.current[ip];
    const infoRes = await apiGet(ip, '/info');
    if (!infoRes) return null;
    const xml = new DOMParser().parseFromString(infoRes, 'text/xml');
    const id = xml.querySelector('info')?.getAttribute('deviceID') || null;
    if (id) deviceIds.current[ip] = id;
    return id;
  };

  const syncSpeakerTo = async (sourceIp, targetIp) => {
    const targetGroup = groups.find(g => g.speakers.some(s => s.ip === targetIp));
    if (!targetGroup) {
      alert('Could not find target speaker group.');
      return;
    }

    const masterIp = targetGroup.masterIp || targetIp;
    const memberIps = Array.from(new Set([...(targetGroup.speakers.map(s => s.ip)), sourceIp]));
    const masterDeviceId = await getDeviceId(masterIp);
    if (!masterDeviceId) {
      alert('Could not determine master device ID for ' + masterIp);
      return;
    }

    const memberData = await Promise.all(memberIps.map(async (ip) => {
      const deviceId = await getDeviceId(ip);
      return deviceId ? { ip, deviceId } : null;
    }));

    const missing = memberData.filter(Boolean).length !== memberIps.length;
    if (missing) {
      alert('Could not reach one or more speakers required for sync.');
      return;
    }

    const membersXml = memberData.map(m => '<member ipaddress="' + m.ip + '">' + m.deviceId + '</member>').join('');
    const xml = '<?xml version="1.0" encoding="UTF-8"?>' +
      '<zone master="' + masterDeviceId + '" senderIPAddress="' + masterIp + '">' +
      membersXml + '</zone>';

    await apiPost(masterIp, '/setZone', xml);
    setTimeout(pollAll, 1200);
  };

  const addSpeakerToGroup = async (masterIp, newSpeakerIp) => {
    const masterDeviceId = await getDeviceId(masterIp);
    if (!masterDeviceId) {
      alert('Could not determine master device ID for ' + masterIp);
      return;
    }

    const newDeviceId = await getDeviceId(newSpeakerIp);
    if (!newDeviceId) {
      alert('Could not determine device ID for ' + newSpeakerIp);
      return;
    }

    // Check if master already has existing zone members
    const masterGroup = groups.find(g => g.masterIp === masterIp);
    const alreadyMaster = masterGroup && masterGroup.speakers.length > 1;

    let membersXml = '<member ipaddress="' + newSpeakerIp + '">' + newDeviceId + '</member>';

    // If adding to existing zone, include all current members + new one
    if (alreadyMaster) {
      const existingMemberIps = new Set(masterGroup.speakers.map(s => s.ip).filter(ip => ip !== masterIp));
      existingMemberIps.add(newSpeakerIp);
      const memberData = await Promise.all(
        Array.from(existingMemberIps).map(async ip => ({
          ip,
          deviceId: await getDeviceId(ip)
        }))
      );
      membersXml = memberData.map(m => '<member ipaddress="' + m.ip + '">' + m.deviceId + '</member>').join('');
    }

    const xml = '<?xml version="1.0" encoding="UTF-8"?>' +
      '<zone master="' + masterDeviceId + '" senderIPAddress="' + masterIp + '">' +
      membersXml + '</zone>';

    await apiPost(masterIp, '/setZone', xml);
    setTimeout(pollAll, 1200);
  };

  const removeSpeakerFromGroup = async (masterIp, removeIp) => {
    const masterDeviceId = await getDeviceId(masterIp);
    if (!masterDeviceId) {
      alert('Could not determine master device ID for ' + masterIp);
      return;
    }

    const removeDeviceId = await getDeviceId(removeIp);
    if (!removeDeviceId) {
      alert('Could not determine device ID for ' + removeIp);
      return;
    }

    const xml = '<?xml version="1.0" encoding="UTF-8"?>' +
      '<zone master="' + masterDeviceId + '">' +
      '<member ipaddress="' + removeIp + '">' + removeDeviceId + '</member>' +
      '</zone>';

    await apiPost(masterIp, '/removeZoneSlave', xml);
    setTimeout(pollAll, 1200);
  };

  const onVolumeChange = (ip, level, immediate = false) => {
    setSpeakerData(prev => ({
      ...prev,
      [ip]: { ...prev[ip], volume: level }
    }));
    if (immediate) {
      apiPost(ip, '/volume', '<volume>' + level + '</volume>');
    } else {
      clearTimeout(volumeTimers.current[ip]);
      volumeTimers.current[ip] = setTimeout(() => {
        apiPost(ip, '/volume', '<volume>' + level + '</volume>');
      }, 250);
    }
  };

  const onMute = (ip) => {
    const current = speakerData[ip];
    if (!current) return;
    const newMuted = !current.muted;
    setSpeakerData(prev => ({ ...prev, [ip]: { ...prev[ip], muted: newMuted } }));
    apiPost(ip, '/volume', '<volume>' + current.volume + '<muteenabled>' + newMuted + '</muteenabled></volume>');
  };

  const onKey = (ip, key) => {
    apiPost(ip, '/key', '<key state="press" sender="Gabbo">' + key + '</key>');
    setTimeout(() => apiPost(ip, '/key', '<key state="release" sender="Gabbo">' + key + '</key>'), 100);
    if (key === 'PLAY_PAUSE' || key.startsWith('PRESET_')) setTimeout(pollAll, 800);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center">
        <p className="text-slate-400 text-sm">Scanning speakers...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-4">
      <div className="max-w-2xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-2xl font-bold text-white">SoundTouch</h1>
            <p className="text-slate-500 text-xs mt-0.5">
              {lastUpdated ? 'Updated ' + lastUpdated.toLocaleTimeString() : 'Scanning speakers... (' + Object.keys(speakerData).length + '/' + speakers.length + ')'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={pollAll}
              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white rounded-lg text-xs transition">
              Refresh
            </button>
            <a href="/"
              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white rounded-lg text-xs transition">
              Classic
            </a>
          </div>
        </div>

        {/* Speaker groups */}
        <div className="space-y-3">
          {groups.map(group => (
            <GroupCard key={group.id} group={group}
              onVolumeChange={onVolumeChange} onMute={onMute} onKey={onKey}
              onSyncTo={syncSpeakerTo} onAddToGroup={addSpeakerToGroup} onRemoveFromGroup={removeSpeakerFromGroup}
              otherSpeakers={speakers.filter(s => !group.speakers.some(gs => gs.ip === s.ip))}
              speakerData={speakerData}
              groups={groups}
          />
          ))}
        </div>

        {/* Loading indicator */}
        {!lastUpdated && (
          <div className="mt-4 text-center">
            <p className="text-slate-400 text-sm mb-2">Scanning speakers...</p>
            <div className="w-full bg-slate-700 rounded-full h-2">
              <div className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                   style={{ width: (Object.keys(speakerData).length / SPEAKERS.length) * 100 + '%' }}></div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

ReactDOM.render(<AllSpeakersView/>, document.getElementById('root'));
