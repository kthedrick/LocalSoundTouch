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
  if (spk.brand === 'wiim') {
    try {
      const res = await fetch('/wiim/status?ip=' + spk.ip);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      return { ip: spk.ip, name: spk.name, brand: 'wiim', volume: d.volume, muted: d.muted,
               nowPlaying: d.nowPlaying, playStatus: d.playStatus,
               zoneInfo: null, presets: [], reachable: true };
    } catch {
      return { ip: spk.ip, name: spk.name, brand: 'wiim', volume: 0, muted: false,
               nowPlaying: null, playStatus: null, zoneInfo: null, presets: [],
               reachable: false, failedCall: 'status' };
    }
  }

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

  const [volRes, npRes, zoneRes, presetRes, queueStateRes] = await Promise.all([
    apiGet(spk.ip, '/volume'),
    apiGet(spk.ip, '/now_playing'),
    apiGet(spk.ip, '/getZone'),
    apiGet(spk.ip, '/presets'),
    fetch('/upnp/queue/state?speakerIp=' + spk.ip).then(r => r.json()).catch(() => null),
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
      repeatSetting: xml.querySelector('repeatSetting')?.textContent || 'REPEAT_OFF',
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

  const upnpRepeat = queueStateRes?.repeatMode || 'REPEAT_OFF';
  return { ip: spk.ip, name: spk.name, volume, muted, nowPlaying, playStatus, zoneInfo, presets, reachable: true, failedCall, upnpRepeat };
}

// ── MABrowserModal ────────────────────────────────────────────────────────────
function MABrowserModal({ speakerName, queueId, onClose, onBeforePlay, onFilesystem }) {
  const [stack, setStack]   = useState([{ uri: '', title: 'Library' }]);
  const [items, setItems]   = useState(null);
  const [error, setError]   = useState(null);
  const [status, setStatus] = useState(null);

  useEffect(() => { document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = ''; }; }, []);

  const current = stack[stack.length - 1];

  useEffect(() => {
    setItems(null);
    setError(null);
    let qs = current.uri ? '?uri=' + encodeURIComponent(current.uri) : '';
    if (current.uri && current.title) qs += '&name=' + encodeURIComponent(current.title);
    fetch('/ha/browse-ma' + qs)
      .then(r => r.json())
      .then(d => {
        if (d.ok) setItems(d.items);
        else setError(d.error || 'Browse failed');
      })
      .catch(e => setError(String(e)));
  }, [current.uri]);

  const play = async (item) => {
    if (onBeforePlay) await onBeforePlay();
    setStatus('Starting ' + item.name + '...');
    try {
      const res = await fetch('/ha/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queueId, uri: item.uri, name: item.name }),
      });
      const d = await res.json();
      if (d.ok) { setStatus(item.name + ' started'); setTimeout(onClose, 800); }
      else setStatus('Error: ' + (d.error || 'unknown'));
    } catch (e) { setStatus('Error: ' + e.message); }
  };

  const enter = (item) => {
    // Redirect filesystem provider to the NAS browser
    if (onFilesystem && (item.uri || '').startsWith('filesystem_')) {
      onFilesystem(item.uri);
      return;
    }
    setStack(prev => [...prev, { uri: item.uri, title: item.name }]);
  };

  const back = () => {
    setStack(prev => prev.length > 1 ? prev.slice(0, -1) : prev);
  };

  const mediaIcon = (item) => {
    const mt = (item.mediaType || '').toLowerCase();
    if (mt === 'radio')    return '📻';
    if (mt === 'album')    return '💿';
    if (mt === 'artist')   return '🎤';
    if (mt === 'playlist') return '🎵';
    if (mt === 'track')    return '🎵';
    return item.canExpand ? '📁' : '▶';
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-70 flex items-end sm:items-center justify-center p-0 pb-10 sm:p-4 z-50"
         onClick={onClose}>
      <div className="bg-slate-800 rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[85vh] flex flex-col border border-slate-700"
           onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {stack.length > 1 && (
              <button onClick={back} className="text-slate-400 hover:text-white text-sm font-bold flex-shrink-0">← Back</button>
            )}
            <div className="min-w-0">
              <h2 className="text-white font-semibold text-sm truncate">{current.title}</h2>
              <p className="text-blue-400 text-xs">{speakerName}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none flex-shrink-0 ml-2">✕</button>
        </div>
        {/* Status */}
        {status && (
          <div className="px-4 py-2 bg-slate-700/50 text-slate-300 text-xs flex-shrink-0">{status}</div>
        )}
        {/* List */}
        <div className="overflow-y-auto flex-1 py-2">
          {!items && !error && (
            <div className="px-4 py-8 text-center text-slate-400 text-sm">Loading...</div>
          )}
          {error && (
            <div className="px-4 py-4 text-red-400 text-sm">{error}</div>
          )}
          {items && items.map((item, i) => (
            <div key={i} className="flex items-center hover:bg-slate-700 transition">
              <button
                onClick={() => item.canExpand ? enter(item) : play(item)}
                className="flex-1 text-left px-4 py-2.5 flex items-center gap-3 min-w-0">
                {item.image
                  ? <img src={item.image} alt="" className="w-8 h-8 rounded object-cover flex-shrink-0" />
                  : <span className="text-slate-400 text-sm flex-shrink-0 w-8 text-center">{mediaIcon(item)}</span>
                }
                <span className="text-slate-200 text-sm truncate flex-1">{item.name}</span>
                {item.canExpand && <span className="text-slate-500 text-xs flex-shrink-0">›</span>}
              </button>
              {item.canExpand && item.canPlay && (
                <button
                  onClick={() => play(item)}
                  className="px-3 py-2.5 text-slate-400 hover:text-white text-base flex-shrink-0"
                  title="Play">
                  ▶
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── NasBrowserModal ───────────────────────────────────────────────────────────
function NasBrowserModal({ speakerIp, speakerName, onClose, initialPath, onBeforePlay, queueId, maFilesystemBase }) {
  const [serverBase, setServerBase] = useState('');
  const [currentPath, setCurrentPath] = useState(initialPath || '/volume1/music');
  const [entries, setEntries] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [shuffle, setShuffle] = useState(false);

  useEffect(() => { document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = ''; }; }, []);

  useEffect(() => {
    fetch('/serverInfo').then(r => r.json()).then(d => setServerBase(d.base)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!serverBase) return;
    setLoading(true);
    setError(null);
    fetch('/nas/browse?path=' + encodeURIComponent(currentPath))
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(data => { setEntries(data); setLoading(false); })
      .catch(e => { setError(String(e)); setLoading(false); });
  }, [currentPath, serverBase]);

  const navigate = (folder) => {
    const next = (currentPath === '/' ? '' : currentPath) + '/' + folder;
    setCurrentPath(next);
  };

  const navigateTo = (idx) => {
    const ROOT_DEPTH = 2; // volume1/music
    const parts = currentPath.split('/').filter(Boolean);
    const next = '/' + parts.slice(0, ROOT_DEPTH + idx + 1).join('/');
    setCurrentPath(next);
  };

  // Convert FTP path to MA filesystem URI: /volume1/music/... → maFilesystemBase + folder/music/...
  const ftpToMaUri = (ftpPath) => {
    const relative = ftpPath.replace(/^\/volume\d+\//, '');
    const base = (maFilesystemBase || '').replace(/\/$/, '');
    return base + '/folder/' + relative;
  };

  const playUrl = async (url, title, artUrl) => {
    if (onBeforePlay) await onBeforePlay();
    setStatus('Playing: ' + title);
    try {
      if (queueId && maFilesystemBase) {
        // Play through MA/AirPlay using the filesystem URI
        const ftpPath = new URL(url).searchParams.get('path');
        const maUri = ftpToMaUri(ftpPath);
        const res = await fetch('/ha/play', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ queueId, uri: maUri }),
        });
        const data = await res.json();
        if (!data.ok) setStatus('Error: ' + (data.error || 'unknown'));
      } else {
        const res = await fetch('/upnp/play', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ speakerIp, url, title, artUrl }),
        });
        const data = await res.json();
        if (!data.ok) setStatus('Error: ' + data.error);
      }
    } catch (e) {
      setStatus('Error: ' + e.message);
    }
  };

  const shuffleArray = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const playTrack = (file) => {
    const filePath = (currentPath === '/' ? '' : currentPath) + '/' + file;
    const url = serverBase + '/nas/stream?path=' + encodeURIComponent(filePath);
    const artUrl = entries?.artFile
      ? serverBase + '/nas/art?path=' + encodeURIComponent(currentPath.replace(/\/$/, '') + '/' + entries.artFile)
      : null;
    playUrl(url, file.replace(/\.[^.]+$/, ''), artUrl);
  };

  const queueFolder = async (folderPath, title) => {
    if (onBeforePlay) await onBeforePlay();
    setStatus('Loading...');
    try {
      if (queueId && maFilesystemBase) {
        // Play folder through MA using filesystem URI
        const maUri = ftpToMaUri(folderPath);
        const res = await fetch('/ha/play', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ queueId, uri: maUri }),
        });
        const d = await res.json();
        if (!d.ok) setStatus('Error: ' + (d.error || 'unknown'));
        else { setStatus('Playing: ' + title); setTimeout(onClose, 800); }
      } else {
        const data = await fetch('/nas/browse?path=' + encodeURIComponent(folderPath)).then(r => r.json());
        let files = data.files || [];
        if (shuffle) files = shuffleArray(files);
        if (!files.length) { setStatus('No audio files found'); return; }
        const base = folderPath.replace(/\/$/, '');
        const artUrl = data.artFile
          ? serverBase + '/nas/art?path=' + encodeURIComponent(base + '/' + data.artFile)
          : null;
        const tracks = files.map(f => ({
          url: serverBase + '/nas/stream?path=' + encodeURIComponent(base + '/' + f),
          title: f.replace(/\.[^.]+$/, ''),
          artUrl,
        }));
        const res = await fetch('/upnp/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ speakerIp, tracks }),
        });
        const d = await res.json();
        if (!d.ok) setStatus('Error: ' + d.error);
        else setStatus('Queue: ' + title + ' (' + tracks.length + ' tracks' + (shuffle ? ', shuffled' : '') + ')');
      }
    } catch (e) {
      setStatus('Error: ' + e.message);
    }
  };

  const playFolder = (folder) => {
    const folderPath = (currentPath === '/' ? '' : currentPath) + '/' + folder;
    queueFolder(folderPath, folder);
  };

  const playCurrentFolder = () => {
    const name = currentPath.split('/').filter(Boolean).pop() || 'folder';
    queueFolder(currentPath, name);
  };

  const breadcrumbs = currentPath.split('/').filter(Boolean).slice(2); // skip volume1/music

  return (
    <div className="fixed inset-0 bg-black bg-opacity-70 flex items-end sm:items-center justify-center p-0 pb-10 sm:p-4 z-50"
         onClick={onClose}>
      <div className="bg-slate-800 rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[85vh] flex flex-col border border-slate-700"
           onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 flex-shrink-0">
          <div>
            <h2 className="text-white font-semibold text-sm">Browse NAS</h2>
            <p className="text-blue-400 text-xs">{speakerName}</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShuffle(s => !s)}
              className={'px-2 py-1 rounded text-xs transition ' + (shuffle ? 'bg-purple-600 text-white' : 'bg-slate-700 text-slate-400 hover:text-white')}
              title="Shuffle">
              ⇄ Shuffle
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-white text-2xl leading-none px-1">×</button>
          </div>
        </div>

        {/* Breadcrumb */}
        <div className="flex items-center gap-1 px-4 py-2 border-b border-slate-700/60 flex-shrink-0 overflow-x-auto">
          <button onClick={() => setCurrentPath('/volume1/music')}
            className="text-blue-400 hover:text-blue-300 text-xs whitespace-nowrap">Music</button>
          {breadcrumbs.map((seg, i) => (
            <span key={i} className="flex items-center gap-1">
              <span className="text-slate-600 text-xs">/</span>
              <button onClick={() => navigateTo(i)}
                className="text-blue-400 hover:text-blue-300 text-xs whitespace-nowrap truncate max-w-[120px]"
                title={seg}>{seg}</button>
            </span>
          ))}
          {breadcrumbs.length > 0 && entries && entries.files && entries.files.length > 0 && (
            <button onClick={playCurrentFolder}
              className="ml-auto flex-shrink-0 px-2 py-0.5 bg-green-600 hover:bg-green-500 text-white rounded text-xs">
              ▶ All
            </button>
          )}
        </div>

        {/* Status bar */}
        {status && (
          <div className="px-4 py-1.5 bg-blue-900 bg-opacity-40 border-b border-slate-700/60 flex-shrink-0">
            <p className="text-blue-300 text-xs truncate">{status}</p>
          </div>
        )}

        {/* Content */}
        <div className="overflow-y-auto flex-1">
          {loading && (
            <div className="flex items-center justify-center py-12 text-slate-500 text-sm">Loading…</div>
          )}
          {error && (
            <div className="px-4 py-6 text-rose-400 text-sm">{error}</div>
          )}
          {!loading && !error && entries && (
            <div className="divide-y divide-slate-700/40">
              {entries.folders.map(folder => (
                <div key={folder} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-700/40">
                  <span className="text-slate-400 text-base flex-shrink-0">📁</span>
                  <button onClick={() => navigate(folder)}
                    className="flex-1 text-left text-slate-200 text-sm truncate">{folder}</button>
                  <button onClick={() => playFolder(folder)}
                    className="flex-shrink-0 px-2 py-1 bg-green-700 hover:bg-green-600 text-white rounded text-xs">
                    ▶ All
                  </button>
                </div>
              ))}
              {entries.files.map(file => (
                <div key={file} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-700/40">
                  <span className="text-slate-400 text-base flex-shrink-0">🎵</span>
                  <span className="flex-1 text-slate-300 text-sm truncate"
                        title={file}>{file.replace(/\.[^.]+$/, '')}</span>
                  <button onClick={() => playTrack(file)}
                    className="flex-shrink-0 px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs">
                    ▶
                  </button>
                </div>
              ))}
              {entries.folders.length === 0 && entries.files.length === 0 && (
                <p className="px-4 py-8 text-slate-500 text-sm text-center">Empty folder</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── WholeHouseView ────────────────────────────────────────────────────────────
function WholeHouseView({ speakerData, maGroups, maTrackData, onClose }) {
  const GROUP_COLORS = ['#3b82f6','#10b981','#a855f7','#f59e0b','#ef4444','#06b6d4','#f97316'];

  // Map each speaker name → { color, isLeader, groupIdx }
  const groupInfo = {};
  maGroups.forEach(({ leader, members }, idx) => {
    const color = GROUP_COLORS[idx % GROUP_COLORS.length];
    groupInfo[leader] = { color, isLeader: true, idx };
    members.forEach(m => { groupInfo[m] = { color, isLeader: false, idx }; });
  });

  const shortName = n => n.replace(/^Bose-/, '').replace(/^WiiM /, '');

  const statusColor = (d) => {
    if (!d) return '#1f2937';
    if (d.playStatus === 'PLAY_STATE')  return '#22c55e';
    if (d.playStatus === 'PAUSE_STATE') return '#f59e0b';
    return '#374151';
  };

  const npLine = (spk, d) => {
    const mt = maTrackData?.[spk.name];
    if (mt?.track)                  return mt.track;
    if (d?.nowPlaying?.stationName) return d.nowPlaying.stationName;
    if (d?.nowPlaying?.track)       return d.nowPlaying.track;
    if (d?.nowPlaying?.source && d.nowPlaying.source !== 'STANDBY') return d.nowPlaying.source;
    return null;
  };

  // Sort so grouped speakers cluster together (by group index, leader first), then standalones
  const origOrder = {};
  SPEAKERS.forEach((s, i) => { origOrder[s.ip] = i; });

  const sorted = [...SPEAKERS].sort((a, b) => {
    const ga = groupInfo[a.name], gb = groupInfo[b.name];
    if (ga && gb && ga.idx === gb.idx) {
      if (ga.isLeader !== gb.isLeader) return ga.isLeader ? -1 : 1;
      return origOrder[a.ip] - origOrder[b.ip];
    }
    if (ga && gb) return ga.idx - gb.idx;
    if (ga) return -1;
    if (gb) return 1;
    return origOrder[a.ip] - origOrder[b.ip];
  });

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ backgroundColor: '#080d18' }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800 flex-shrink-0">
        <span className="text-white font-semibold text-sm flex-shrink-0">All Rooms</span>
        {/* Active group legend */}
        {maGroups.length > 0 && (
          <div className="flex items-center gap-3 flex-1 overflow-x-auto min-w-0">
            {maGroups.map(({ leader, members }, idx) => (
              <div key={idx} className="flex items-center gap-1.5 flex-shrink-0">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: GROUP_COLORS[idx % GROUP_COLORS.length] }} />
                <span className="text-slate-400 text-xs whitespace-nowrap">
                  {shortName(leader)} +{members.length}
                </span>
              </div>
            ))}
          </div>
        )}
        <button onClick={onClose} className="ml-auto text-slate-500 text-xl leading-none px-1 flex-shrink-0">✕</button>
      </div>

      {/* Speaker grid */}
      <div className="flex-1 overflow-y-auto p-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {sorted.map(spk => {
            const d    = speakerData[spk.ip];
            const g    = groupInfo[spk.name];
            const playing = d?.playStatus === 'PLAY_STATE';
            const text = npLine(spk, d);
            const vol  = d?.volume ?? null;

            return (
              <div key={spk.ip} className="rounded-xl p-3 relative"
                style={{
                  backgroundColor: g ? g.color + '14' : '#1e293b',
                  borderTop: '3px solid ' + (g ? g.color : 'transparent'),
                  opacity: d ? 1 : 0.35,
                }}>
                {/* Name + status dot */}
                <div className="flex items-center gap-1.5 min-w-0">
                  <div className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: statusColor(d) }} />
                  <span className="text-white text-xs font-semibold truncate flex-1">
                    {shortName(spk.name)}
                  </span>
                  {g?.isLeader && (
                    <span className="text-[9px] font-bold px-1 rounded flex-shrink-0"
                      style={{ color: g.color, backgroundColor: g.color + '28' }}>
                      LEAD
                    </span>
                  )}
                </div>

                {/* Now playing text */}
                <div className="text-[11px] truncate mt-1" style={{ minHeight: '14px', color: playing ? '#94a3b8' : '#374151' }}>
                  {text || ''}
                </div>

                {/* Volume bar */}
                {vol !== null && (
                  <div className="mt-2 flex items-center gap-1.5">
                    <div className="flex-1 h-0.5 rounded-full" style={{ backgroundColor: '#1e293b' }}>
                      <div className="h-full rounded-full"
                        style={{
                          width: vol + '%',
                          backgroundColor: g ? g.color : '#3b82f6',
                          opacity: playing ? 0.85 : 0.25,
                        }} />
                    </div>
                    <span className="text-[10px] tabular-nums w-5 text-right"
                      style={{ color: playing ? '#64748b' : '#1f2937' }}>
                      {vol}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Toggle switch ─────────────────────────────────────────────────────────────
function Toggle({ on, onChange }) {
  return (
    <button
      onPointerDown={(e) => { e.preventDefault(); onChange(!on); }}
      className={'relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none ' +
        (on ? 'bg-blue-600' : 'bg-slate-600')}>
      <span className={'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ' +
        (on ? 'translate-x-6' : 'translate-x-1')} />
    </button>
  );
}

// ── SoundSettingsModal ────────────────────────────────────────────────────────
// SoundTouch 300 uses undocumented endpoints — NOT the standard /bass endpoint.
// Refs: /audioproducttonecontrols, /audioproductlevelcontrols, /audiospeakerattributeandsetting
//       /audiodspcontrols, /productcechdmicontrol
function SoundSettingsModal({ ip, speakerName, initialVolume, onVolumeChange, onClose }) {
  const [volume, setVolume]               = useState(initialVolume || 0);
  const [bass, setBass]                   = useState(0);
  const [bassOn, setBassOn]               = useState(false);
  const [treble, setTreble]               = useState(0);
  const [surroundOn, setSurroundOn]       = useState(false);
  const [surroundLevel, setSurroundLevel] = useState(0);
  const [centerLevel, setCenterLevel]     = useState(0);
  const [dialogMode, setDialogMode]       = useState(false);  // true = AUDIO_MODE_DIALOG
  const [cecMode, setCecMode]             = useState('CEC_MODE_ON');
  const [loading, setLoading]             = useState(true);
  const bassTimer     = useRef(null);
  const trebleTimer   = useRef(null);
  const surroundTimer = useRef(null);
  const centerTimer   = useRef(null);
  const volTimer      = useRef(null);

  useEffect(() => { document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = ''; }; }, []);

  useEffect(() => {
    async function load() {
      const [toneRes, levelRes, attrRes, dspRes, cecRes] = await Promise.all([
        apiGet(ip, '/audioproducttonecontrols'),
        apiGet(ip, '/audioproductlevelcontrols'),
        apiGet(ip, '/audiospeakerattributeandsetting'),
        apiGet(ip, '/audiodspcontrols'),
        apiGet(ip, '/productcechdmicontrol'),
      ]);
      if (toneRes) {
        const x = new DOMParser().parseFromString(toneRes, 'text/xml');
        setBass(parseInt(x.querySelector('bass')?.getAttribute('value') || '0'));
        setTreble(parseInt(x.querySelector('treble')?.getAttribute('value') || '0'));
      }
      if (levelRes) {
        const x = new DOMParser().parseFromString(levelRes, 'text/xml');
        setSurroundLevel(parseInt(x.querySelector('rearSurroundSpeakersLevel')?.getAttribute('value') || '0'));
        setCenterLevel(parseInt(x.querySelector('frontCenterSpeakerLevel')?.getAttribute('value') || '0'));
      }
      if (attrRes) {
        const x = new DOMParser().parseFromString(attrRes, 'text/xml');
        setBassOn(x.querySelector('subwoofer01')?.getAttribute('active') === 'true');
        setSurroundOn(x.querySelector('rear')?.getAttribute('active') === 'true');
      }
      if (dspRes) {
        const x = new DOMParser().parseFromString(dspRes, 'text/xml');
        setDialogMode(x.querySelector('audiodspcontrols')?.getAttribute('audiomode') === 'AUDIO_MODE_DIALOG');
      }
      if (cecRes) {
        const x = new DOMParser().parseFromString(cecRes, 'text/xml');
        setCecMode(x.querySelector('productcechdmicontrol')?.getAttribute('cecmode') || 'CEC_MODE_ON');
      }
      setLoading(false);
    }
    load();
  }, [ip]);

  const handleVolume = (level) => {
    const v = Math.max(0, Math.min(100, level));
    setVolume(v);
    clearTimeout(volTimer.current);
    volTimer.current = setTimeout(() => onVolumeChange(ip, v, true), 150);
  };

  // Tone controls: step 25, range -100 to 100
  const handleBass = (level) => {
    const v = Math.max(-100, Math.min(100, Math.round(level / 25) * 25));
    setBass(v);
    clearTimeout(bassTimer.current);
    bassTimer.current = setTimeout(() => {
      apiPost(ip, '/audioproducttonecontrols',
        '<audioproducttonecontrols><bass value="' + v + '" /></audioproducttonecontrols>');
    }, 300);
  };

  const handleTreble = (level) => {
    const v = Math.max(-100, Math.min(100, Math.round(level / 25) * 25));
    setTreble(v);
    clearTimeout(trebleTimer.current);
    trebleTimer.current = setTimeout(() => {
      apiPost(ip, '/audioproducttonecontrols',
        '<audioproducttonecontrols><treble value="' + v + '" /></audioproducttonecontrols>');
    }, 300);
  };

  const toggleBassOn = (next) => {
    setBassOn(next);
    apiPost(ip, '/audiospeakerattributeandsetting',
      '<audiospeakerattributeandsetting><subwoofer01 active="' + next + '" /></audiospeakerattributeandsetting>');
  };

  const toggleSurroundOn = (next) => {
    setSurroundOn(next);
    apiPost(ip, '/audiospeakerattributeandsetting',
      '<audiospeakerattributeandsetting><rear active="' + next + '" /></audiospeakerattributeandsetting>');
  };

  // Level controls: step 10, range -100 to 100
  const handleSurroundLevel = (level) => {
    const v = Math.max(-100, Math.min(100, Math.round(level / 10) * 10));
    setSurroundLevel(v);
    clearTimeout(surroundTimer.current);
    surroundTimer.current = setTimeout(() => {
      apiPost(ip, '/audioproductlevelcontrols',
        '<audioproductlevelcontrols><rearSurroundSpeakersLevel value="' + v + '" /></audioproductlevelcontrols>');
    }, 300);
  };

  const handleCenter = (level) => {
    const v = Math.max(-100, Math.min(100, Math.round(level / 10) * 10));
    setCenterLevel(v);
    clearTimeout(centerTimer.current);
    centerTimer.current = setTimeout(() => {
      apiPost(ip, '/audioproductlevelcontrols',
        '<audioproductlevelcontrols><frontCenterSpeakerLevel value="' + v + '" /></audioproductlevelcontrols>');
    }, 300);
  };

  const toggleDialogMode = (next) => {
    setDialogMode(next);
    apiPost(ip, '/audiodspcontrols',
      '<audiodspcontrols audiomode="' + (next ? 'AUDIO_MODE_DIALOG' : 'AUDIO_MODE_NORMAL') + '" />');
  };

  const selectCec = (mode) => {
    setCecMode(mode);
    apiPost(ip, '/productcechdmicontrol',
      '<productcechdmicontrol cecmode="' + mode + '" />');
  };

  const sliderStyle = (val, min, max, disabled) => {
    const pct    = Math.round(((val - min) / (max - min)) * 100);
    const fill   = disabled ? '#475569' : '#3b82f6';
    const track  = disabled ? '#1e293b' : '#334155';
    return { background: `linear-gradient(to right, ${fill} 0%, ${fill} ${pct}%, ${track} ${pct}%, ${track} 100%)` };
  };

  const fmtVal   = (v) => v > 0 ? '+' + v : String(v);
  const labelCls = 'text-slate-300 text-xs font-semibold uppercase tracking-wider';
  const onOffCls = (on) => 'text-sm ' + (on !== false ? 'text-white' : 'text-slate-500');
  const numCls   = (on) => 'text-sm tabular-nums w-10 text-right ' + (on !== false ? 'text-slate-300' : 'text-slate-600');
  const rowCls   = (on) => 'flex items-center gap-2 ' + (on === false ? 'opacity-40 pointer-events-none' : '');
  const btnCls   = 'w-8 h-8 flex items-center justify-center rounded bg-slate-700 active:bg-slate-500 text-white text-base font-mono leading-none flex-shrink-0 focus:outline-none select-none';

  // Slider control: with toggle → header shows On/Off + switch, value moves to end of slider row
  //                 without toggle → header shows value on right
  const ControlRow = ({ label, value, min, max, step, onSlider, onMinus, onPlus, toggle, active }) => (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className={labelCls}>{label}</span>
        {toggle && (
          <div className="flex items-center gap-2">
            <span className={onOffCls(active)}>{active !== false ? 'On' : 'Off'}</span>
            {toggle}
          </div>
        )}
      </div>
      <div className={rowCls(active)}>
        <button onClick={onMinus} className={btnCls}>−</button>
        <input type="range" min={min} max={max} step={step || 1} value={value}
          onChange={e => onSlider(parseInt(e.target.value))}
          className="flex-1 h-2 rounded-full appearance-none cursor-pointer"
          style={sliderStyle(value, min, max, active === false)} />
        <button onClick={onPlus} className={btnCls}>+</button>
        <span className={numCls(active)}>{fmtVal(value)}</span>
      </div>
    </div>
  );

  // Toggle-only row (no slider)
  const ToggleRow = ({ label, on, onChange }) => (
    <div className="flex items-center justify-between">
      <span className={labelCls}>{label}</span>
      <div className="flex items-center gap-2">
        <span className={onOffCls(on)}>{on ? 'On' : 'Off'}</span>
        <Toggle on={on} onChange={onChange} />
      </div>
    </div>
  );

  const CEC_MODES = [
    ['CEC_MODE_ON',           'On'],
    ['CEC_MODE_ALTERNATE_ON', 'Alt On'],
    ['CEC_MODE_OFF',          'Off'],
  ];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-70 flex items-end sm:items-center justify-center p-0 sm:p-4 z-50"
         onClick={onClose}>
      <div className="bg-slate-800 rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm border border-slate-700 flex flex-col max-h-[96vh] sm:max-h-[90vh]"
           onClick={e => e.stopPropagation()}>

        {/* Header — fixed */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 flex-shrink-0">
          <div>
            <h2 className="text-white font-semibold text-sm">Sound Settings</h2>
            <p className="text-blue-400 text-xs">{speakerName}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg leading-none px-1">×</button>
        </div>

        {/* Scrollable content */}
        {loading ? (
          <div className="px-4 py-8 text-center text-slate-400 text-sm">Loading…</div>
        ) : (
          <div className="overflow-y-auto flex-1 px-4 py-5 space-y-5 pb-8">

            {/* ── Levels ── */}
            <ControlRow label="Volume"
              value={volume} min={0} max={100}
              onSlider={handleVolume}
              onMinus={() => handleVolume(volume - 1)}
              onPlus={() => handleVolume(volume + 1)} />

            <ControlRow label="Bass"
              value={bass} min={-100} max={100} step={25}
              onSlider={handleBass}
              onMinus={() => handleBass(bass - 25)}
              onPlus={() => handleBass(bass + 25)}
              active={bassOn}
              toggle={<Toggle on={bassOn} onChange={toggleBassOn} />} />

            <ControlRow label="Treble"
              value={treble} min={-100} max={100} step={25}
              onSlider={handleTreble}
              onMinus={() => handleTreble(treble - 25)}
              onPlus={() => handleTreble(treble + 25)} />

            <ControlRow label="Surround"
              value={surroundLevel} min={-100} max={100} step={10}
              onSlider={handleSurroundLevel}
              onMinus={() => handleSurroundLevel(surroundLevel - 10)}
              onPlus={() => handleSurroundLevel(surroundLevel + 10)}
              active={surroundOn}
              toggle={<Toggle on={surroundOn} onChange={toggleSurroundOn} />} />

            <ControlRow label="Center"
              value={centerLevel} min={-100} max={100} step={10}
              onSlider={handleCenter}
              onMinus={() => handleCenter(centerLevel - 10)}
              onPlus={() => handleCenter(centerLevel + 10)} />

            {/* ── Audio ── */}
            <div className="border-t border-slate-700/60 pt-5">
              <ToggleRow label="Dialog Mode" on={dialogMode} onChange={toggleDialogMode} />
            </div>

            {/* ── HDMI ── */}
            <div className="border-t border-slate-700/60 pt-5">
              <div className="flex items-center justify-between mb-2">
                <span className={labelCls}>HDMI-CEC</span>
                <span className="text-slate-400 text-xs">{CEC_MODES.find(([m]) => m === cecMode)?.[1] ?? cecMode}</span>
              </div>
              <div className="flex gap-1.5">
                {CEC_MODES.map(([mode, label]) => (
                  <button key={mode} onClick={() => selectCec(mode)}
                    className={'flex-1 py-2 rounded-lg text-xs font-medium select-none ' +
                      (cecMode === mode
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-700 text-slate-400 active:bg-slate-600 active:text-white')}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}

// ── GroupCard ─────────────────────────────────────────────────────────────────
function GroupCard({ group, onVolumeChange, onMute, onKey, onRemoveFromGroup, onMaGroupRemove, removingMembers, otherSpeakers, speakerData, groups, onOpenNas, onPlayNasFolder, onMaStop, haConfig, onPlayFavorite, maTrack, pendingGroups, onTogglePendingMember, onEstablishGroup, onEstablishBoseZone, onJoinNow, onAdoptPhantomGroup, stopRestartEnabled, onToggleStopRestart }) {
  const master   = group.speakers.find(s => s.ip === group.masterIp) || group.speakers[0];
  const np       = master?.nowPlaying;
  // Use MA track data to fill in art/track/artist when playing via AIRPLAY or AUX redirect
  const isAirplay  = np?.source === 'AIRPLAY';
  const isMASource = isAirplay || (np?.source === 'AUX' && !!maTrack);
  const effectiveArt      = (isMASource ? maTrack?.art : null) || np?.art || maTrack?.art || null;
  const effectiveTrack    = (isMASource ? maTrack?.track  : null) || np?.track  || maTrack?.track  || null;
  const effectiveArtist   = (isMASource ? maTrack?.artist : null) || np?.artist || maTrack?.artist || null;
  const effectiveDuration = (np?.duration > 0 ? np.duration : null) ?? (maTrack?.duration || 0);
  const maPosition = maTrack?.positionUpdatedAt
    ? Math.min((maTrack.position || 0) + (Date.now() / 1000 - maTrack.positionUpdatedAt), maTrack.duration || 0)
    : (maTrack?.position || 0);
  const effectivePosition = (np?.position > 0 ? np.position : null) ?? maPosition;
  const isStandby   = !np || np.source === 'STANDBY' || np.source === 'INVALID_SOURCE';
  const isPlaying   = master?.playStatus === 'PLAY_STATE';
  const isWiiM      = master?.brand === 'wiim';
  const hasContent  = !isStandby && (np?.track || np?.stationName || np?.source);

  const [position, setPosition] = useState(effectivePosition);
  const [artModal, setArtModal] = useState(false);
  const [favStatus, setFavStatus] = useState(null);
  const [radioBrowser, setRadioBrowser] = useState(false);
  const [pandoraPlaylists, setPandoraPlaylists] = useState([]);
  const [pandoraPlayStatus, setPandoraPlayStatus] = useState(null);
  const [soundSettingsSpk, setSoundSettingsSpk] = useState(null);
  const [upnpRepeatLocal, setUpnpRepeatLocal] = useState(master?.upnpRepeat || 'REPEAT_OFF');
  const [tvResetBusy, setTvResetBusy] = useState(false);
  const [showAllSpeakers, setShowAllSpeakers] = useState(false);
  const [addingMembers, setAddingMembers] = useState(new Set());
  const timerRef = useRef(null);
  const adoptedRef = useRef(false);
  const pairingFreqRef = useRef(null);
  if (pairingFreqRef.current === null) {
    try { pairingFreqRef.current = JSON.parse(localStorage.getItem('pairingFreq') || '{}'); } catch { pairingFreqRef.current = {}; }
  }
  const recordPairing = (leaderName, memberName) => {
    const f = pairingFreqRef.current;
    if (!f[leaderName]) f[leaderName] = {};
    f[leaderName][memberName] = (f[leaderName][memberName] || 0) + 1;
    try { localStorage.setItem('pairingFreq', JSON.stringify(f)); } catch {}
  };
  const maybeAdopt = async () => {
    if (!group.phantomGroup || adoptedRef.current) return;
    adoptedRef.current = true;
    if (onAdoptPhantomGroup) await onAdoptPhantomGroup(group);
  };

  const resetTvAudio = async (ip) => {
    setTvResetBusy(true);
    let appleTvWasActive = false;
    if (master?.nowPlaying?.source === 'PRODUCT') {
      const tvState = await fetch('/ha/tv-state').then(r => r.json()).catch(() => null);
      appleTvWasActive = !!(tvState?.tv?.appleTV);
    }
    try {
      await apiPost(ip, '/key', '<key state="press" sender="Gabbo">POWER</key>');
      await new Promise(r => setTimeout(r, 100));
      await apiPost(ip, '/key', '<key state="release" sender="Gabbo">POWER</key>');
      await new Promise(r => setTimeout(r, 5000));
      if (appleTvWasActive) {
        await fetch('/ha/appletv-on', { method: 'POST' });
        await new Promise(r => setTimeout(r, 3000));
      }
      // Select TV source — Bose auto-powers-on when a source is selected from standby
      await fetch('/api/' + ip + '/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
        body: '<ContentItem source="PRODUCT" sourceAccount="TV"></ContentItem>',
      });
    } finally {
      setTvResetBusy(false);
    }
  };

  useEffect(() => { setUpnpRepeatLocal(master?.upnpRepeat || 'REPEAT_OFF'); }, [master?.upnpRepeat]);

  useEffect(() => {
    fetch('/ha/pandora-playlists').then(r => r.json()).then(d => { if (d.ok) setPandoraPlaylists(d.playlists || []); }).catch(() => {});
  }, []);

  const isUpnp = np?.source === 'UPNP' || np?.source === 'LOCAL_INTERNET_RADIO';
  const repeatMode = isUpnp ? upnpRepeatLocal : (np?.repeatSetting || 'REPEAT_OFF');
  const REPEAT_CYCLE = ['REPEAT_OFF', 'REPEAT_ALL', 'REPEAT_ONE'];
  const cycleRepeat = () => {
    const next = REPEAT_CYCLE[(REPEAT_CYCLE.indexOf(repeatMode) + 1) % REPEAT_CYCLE.length];
    if (isUpnp) {
      setUpnpRepeatLocal(next);
      fetch('/upnp/queue/repeat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speakerIp: group.masterIp, repeatMode: next }) });
    } else {
      onKey(group.masterIp, next);
    }
  };

  const handlePlayFavorite = async (fav) => {
    await maybeAdopt();
    const queueId = (master?.name && haConfig?.speakerQueues?.[master.name]) || fav.defaultQueueId;
    setFavStatus('Starting ' + fav.name + '...');
    try {
      const d = await onPlayFavorite(fav, queueId, group.masterIp);
      setFavStatus(d.ok ? fav.name + ' started ✓' : 'Error: ' + JSON.stringify(d.result || d.error));
    } catch (e) {
      setFavStatus('Error: ' + e.message);
    }
    setTimeout(() => setFavStatus(null), 6000);
  };

  useEffect(() => { setPosition(effectivePosition); }, [effectiveTrack, np?.stationName, np?.source]);

  useEffect(() => {
    clearInterval(timerRef.current);
    if (isPlaying && (effectiveDuration > 0 || isUpnp)) {
      timerRef.current = setInterval(() => setPosition(p => p + 1), 1000);
    }
    return () => clearInterval(timerRef.current);
  }, [isPlaying, effectiveDuration, isUpnp, effectiveTrack]);

  const formatTime = (s) => {
    const n = Math.max(0, Math.floor(s));
    return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
  };

  const pos  = effectiveDuration > 0 ? Math.min(position, effectiveDuration) : position;
  const pct  = effectiveDuration > 0 ? Math.round(pos / effectiveDuration * 100) : 0;

  return (
    <div className="bg-slate-800 rounded-2xl overflow-hidden border border-slate-700">

      {/* ── Now playing ── */}
      {hasContent && (
        <div className="p-4 border-b border-slate-700">
          <div className="flex items-start gap-3">
            {effectiveArt && (
              <img src={effectiveArt} key={effectiveArt} alt="Art"
                   onClick={() => setArtModal(true)}
                   className="w-16 h-16 rounded-lg object-cover flex-shrink-0 cursor-pointer hover:opacity-80 transition-opacity"/>
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                {np.source && (
                  <span className="px-2 py-0.5 bg-blue-600 bg-opacity-40 text-blue-300 text-xs font-bold rounded-full uppercase tracking-wide">
                    {np.source}
                  </span>
                )}
                {maTrack?.provider && (
                  <span className="px-2 py-0.5 bg-blue-600 bg-opacity-40 text-blue-300 text-xs font-bold rounded-full uppercase tracking-wide">
                    {maTrack.provider}
                  </span>
                )}
                {maTrack?.stationName && (
                  <span className="text-slate-400 text-xs">{maTrack.stationName}</span>
                )}
                {np.sourceAccount && np.source !== 'STORED_MUSIC' && np.sourceAccount !== 'AirPlay2DefaultUserName' && !/upnp/i.test(np.sourceAccount) && !/^[a-f0-9-]{10,}$/i.test(np.sourceAccount) && (
                  <span className="text-slate-500 text-xs truncate">{np.sourceAccount.replace(/--[A-Za-z0-9]+$/, '')}</span>
                )}
              </div>
              {np.stationName && (
                <p className="text-slate-400 text-xs truncate">{np.stationName}</p>
              )}
              <p className="text-white font-semibold leading-tight">
                {effectiveTrack || '—'}
              </p>
              {effectiveArtist && (
                <p className="text-slate-300 text-sm">{effectiveArtist}</p>
              )}
            </div>
          </div>

          {/* Playback controls — own row, full width, centered */}
          <div className="flex items-center justify-around mt-3">
              <button onClick={() => onKey(group.masterIp, 'PREV_TRACK')}
                className="p-2 text-slate-400 hover:text-white transition rounded-lg hover:bg-slate-700">
                <PrevIcon size={22}/>
              </button>
              <button onClick={() => onKey(group.masterIp, 'PLAY_PAUSE')}
                className="p-2 text-slate-400 hover:text-white transition rounded-lg hover:bg-slate-700">
                {isPlaying ? <PauseIcon size={22}/> : <PlayIcon size={22}/>}
              </button>
              <button onClick={() => onKey(group.masterIp, 'NEXT_TRACK')}
                className="p-2 text-slate-400 hover:text-white transition rounded-lg hover:bg-slate-700">
                <NextIcon size={22}/>
              </button>
              {!isAirplay && (
                <button onClick={cycleRepeat}
                  className={'p-2 transition rounded-lg relative ' + (repeatMode !== 'REPEAT_OFF' ? 'text-blue-400 hover:text-blue-300 bg-slate-700' : 'text-slate-400 hover:text-white hover:bg-slate-700')}
                  title={repeatMode === 'REPEAT_OFF' ? 'Repeat off' : repeatMode === 'REPEAT_ALL' ? 'Repeat all' : 'Repeat one'}>
                  <RepeatIcon size={22}/>
                  {repeatMode === 'REPEAT_ONE' && (
                    <span className="absolute -top-0.5 -right-0.5 bg-blue-400 text-slate-900 text-[8px] font-bold rounded-full w-3 h-3 flex items-center justify-center leading-none">1</span>
                  )}
                </button>
              )}
          </div>

          {/* Progress bar */}
          {(effectiveDuration > 0 || (isUpnp && pos > 0)) && (
            <div className="flex items-center gap-2 mt-2.5">
              <span className="text-slate-500 text-xs tabular-nums w-10 text-right">{formatTime(pos)}</span>
              <div className="flex-1 h-1 bg-slate-700 rounded-full overflow-hidden">
                {effectiveDuration > 0
                  ? <div className="h-full bg-blue-500 rounded-full" style={{ width: pct + '%' }}/>
                  : <div className="h-full bg-blue-500/50 rounded-full animate-pulse w-full"/>
                }
              </div>
              <span className="text-slate-500 text-xs tabular-nums w-10">
                {effectiveDuration > 0 ? '-' + formatTime(effectiveDuration - pos) : ''}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Phantom group banner */}
      {group.phantomGroup && (
        <div className="px-4 py-2 bg-violet-900/30 border-t border-violet-700/30 flex items-center gap-2">
          <span className="text-violet-300 text-xs">Synced via AirPlay externally</span>
        </div>
      )}

      {/* ── Speakers ── */}
      <div className="border-t border-slate-700/60">
        <div className="px-4 pt-2.5 pb-1">
          <span className="text-slate-400 text-[11px] font-semibold uppercase tracking-wider">Speakers</span>
        </div>

        {/* Checked speakers — in this group */}
        {group.speakers.map(spk => {
          const isRemoving = removingMembers?.has(spk.name);
          return (
          <div key={spk.ip} className={'px-4 py-2 flex items-start gap-2.5 transition-opacity duration-150 ' + (isRemoving ? 'opacity-40' : '')}>
            {isRemoving && group.speakers.length > 1
              ? <div className="w-4 h-4 mt-0.5 flex-shrink-0 flex items-center justify-center">
                  <div className="w-3.5 h-3.5 border-2 border-slate-500 border-t-blue-400 rounded-full animate-spin" />
                </div>
              : <input type="checkbox" checked
                  onChange={() => {
                    if (group.speakers.length <= 1 || group.phantomGroup) return;
                    if (spk.brand === 'wiim' || group.maMembers?.includes(spk.name)) {
                      onMaGroupRemove(spk.name);
                    } else {
                      onRemoveFromGroup(group.masterIp, spk.ip);
                    }
                  }}
                  disabled={group.speakers.length <= 1 || isRemoving || group.phantomGroup}
                  className="w-4 h-4 mt-0.5 accent-blue-500 flex-shrink-0 cursor-pointer disabled:opacity-30"
                />
            }
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-white text-sm font-semibold truncate">{spk.name}</span>
                {spk.reachable && spk.name === 'Bose-Sunroom 300' && (
                  <>
                    <button onClick={() => resetTvAudio(spk.ip)} disabled={tvResetBusy} title="Reset TV audio"
                      className={'p-1 rounded transition ' + (tvResetBusy ? 'text-slate-600 cursor-wait' : 'text-slate-500 hover:text-yellow-400 hover:bg-slate-700')}>
                      {tvResetBusy ? '…' : '↺'}
                    </button>
                    <button onClick={() => setSoundSettingsSpk(spk)} title="Sound settings"
                      className="p-1 rounded transition text-slate-500 hover:text-white hover:bg-slate-700">⚙</button>
                  </>
                )}
                {spk.reachable && (
                  <button onClick={() => onKey(spk.ip, 'POWER')}
                    title={spk.nowPlaying?.source === 'STANDBY' ? 'Power on' : 'Power off'}
                    className={'p-1 rounded transition ' +
                      (spk.nowPlaying?.source === 'STANDBY'
                        ? 'text-slate-600 hover:text-green-400 hover:bg-slate-700'
                        : 'text-slate-400 hover:text-red-400 hover:bg-slate-700')}>
                    <PowerIcon size={13}/>
                  </button>
                )}
              </div>
              {!spk.reachable ? (
                <span className="text-slate-600 text-xs">Unreachable{spk.failedCall ? ' (' + spk.failedCall + ')' : ''}</span>
              ) : (
                <div className="flex items-center gap-1.5 mt-1">
                  <button onClick={() => onMute(spk.ip)}
                    className="p-1 bg-slate-700 hover:bg-slate-600 text-white rounded flex-shrink-0">
                    {spk.muted ? <VolumeIcon size={12}/> : <MuteIcon size={12}/>}
                  </button>
                  <button onClick={() => onVolumeChange(spk.ip, Math.max(0, spk.volume - 1), true)}
                    className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded text-xs font-mono flex-shrink-0">−</button>
                  <input type="range" min="0" max="100" value={spk.volume}
                    onChange={e => onVolumeChange(spk.ip, parseInt(e.target.value))}
                    className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer"
                    style={{ background: 'linear-gradient(to right, #3b82f6 0%, #3b82f6 ' + spk.volume + '%, #334155 ' + spk.volume + '%, #334155 100%)' }}
                  />
                  <button onClick={() => onVolumeChange(spk.ip, Math.min(100, spk.volume + 1), true)}
                    className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded text-xs font-mono flex-shrink-0">+</button>
                  <span className="text-slate-400 text-xs tabular-nums w-7 text-right flex-shrink-0">{spk.volume}</span>
                  {spk.failedCall && <span className="text-rose-400 text-[10px]">!</span>}
                </div>
              )}
            </div>
          </div>
        );})}

        {/* Unchecked speakers — not in this group, sorted by pairing frequency with this leader */}
        {otherSpeakers?.length > 0 && (() => {
          const leaderFreq = pairingFreqRef.current[master?.name] || {};
          const sorted = [...otherSpeakers].sort((a, b) => (leaderFreq[b.name] || 0) - (leaderFreq[a.name] || 0));
          const visible = showAllSpeakers ? sorted : sorted.slice(0, 3);
          const hiddenCount = sorted.length - 3;
          return (
            <div className="mt-1 mb-1">
              <div className="mx-4 border-t border-slate-700/40 mb-1"/>
              {visible.map(spk => {
                const data = speakerData[spk.ip];
                const isSelected = pendingGroups?.[group.masterIp]?.has(spk.ip);
                const inAnotherGroup = groups.some(g => g.id !== group.id && g.speakers.length > 1 && g.speakers.some(s => s.ip === spk.ip));
                const src = data?.nowPlaying?.source;
                const isActive = data?.playStatus === 'PLAY_STATE';
                const srcLabel = !data?.reachable ? 'unreachable'
                  : inAnotherGroup ? 'grouped'
                  : !src || src === 'STANDBY' || src === 'INVALID_SOURCE' ? ''
                  : src === 'AIRPLAY' ? 'AirPlay'
                  : src === 'PRODUCT' ? 'In Use · TV' : src;
                const isAdding = addingMembers.has(spk.ip);
                return (
                  <div key={spk.ip} className={'px-4 py-1.5 flex items-center gap-2.5 transition-opacity duration-150 ' + (isAdding ? 'opacity-40' : '')}>
                    {isAdding
                      ? <div className="w-4 h-4 flex-shrink-0 flex items-center justify-center">
                          <div className="w-3.5 h-3.5 border-2 border-slate-500 border-t-blue-400 rounded-full animate-spin" />
                        </div>
                      : <input type="checkbox" checked={isSelected || false}
                          onChange={async () => {
                            const willAdd = !isSelected;
                            if (!willAdd || isStandby) {
                              onTogglePendingMember(group.masterIp, spk.ip);
                              return;
                            }
                            setAddingMembers(prev => new Set([...prev, spk.ip]));
                            const err = await onJoinNow(group.masterIp, spk.ip);
                            recordPairing(master?.name, spk.name);
                            setAddingMembers(prev => { const s = new Set(prev); s.delete(spk.ip); return s; });
                            if (err) setFavStatus('Join failed: ' + err);
                          }}
                          className="w-4 h-4 accent-blue-500 flex-shrink-0 cursor-pointer"
                        />
                    }
                    <span className={'text-sm truncate flex-1 ' + (isAdding ? 'text-slate-500' : inAnotherGroup ? 'text-slate-500' : 'text-slate-300')}>{spk.name}</span>
                    {srcLabel && !isAdding && (
                      <span className={'text-xs flex-shrink-0 ' + (isActive ? 'text-green-400' : 'text-slate-600')}>{srcLabel}</span>
                    )}
                  </div>
                );
              })}
              {!showAllSpeakers && hiddenCount > 0 && (
                <button onClick={() => setShowAllSpeakers(true)}
                  className="px-4 py-1 text-slate-500 hover:text-slate-300 text-xs transition w-full text-left">
                  show {hiddenCount} more…
                </button>
              )}
              {showAllSpeakers && sorted.length > 3 && (
                <button onClick={() => setShowAllSpeakers(false)}
                  className="px-4 py-1 text-slate-500 hover:text-slate-300 text-xs transition w-full text-left">
                  show less
                </button>
              )}
            </div>
          );
        })()}
      </div>

      {/* Music Assistant */}
      <div className="px-4 py-3 border-t border-slate-700/60">
        <h3 className="text-slate-400 text-xs font-semibold uppercase tracking-wider mb-2">Music Assistant</h3>
        <div className="flex gap-1.5 flex-wrap items-center">
          <button onClick={() => setRadioBrowser(true)}
            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-xs font-medium transition">
            Browse
          </button>
          {haConfig?.favorites?.length > 0 && (
            <div className="w-px h-5 bg-slate-600 flex-shrink-0"/>
          )}
          {haConfig?.favorites?.map((fav, i) => (
            <button key={i} onClick={() => handlePlayFavorite(fav)}
              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-xs font-medium transition flex items-center gap-1.5 flex-shrink-0">
              <span>{fav.icon}</span><span>{fav.name.replace(/ Radio$/i, '')}</span>
            </button>
          ))}
        </div>
        {favStatus && <p className="text-indigo-300 text-xs mt-1.5 italic">{favStatus}</p>}
      </div>

      {/* Pandora Playlists */}
      {pandoraPlaylists.length > 0 && (
        <div className="px-4 py-3 border-t border-slate-700/60">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-slate-400 text-xs font-semibold uppercase tracking-wider">Local Playlists</h3>
            <a href="/playlists.html" target="_blank" className="text-slate-500 hover:text-slate-300 text-xs transition">view all →</a>
          </div>
          <div className="flex flex-col gap-1">
            {pandoraPlaylists.map(pl => (
              <div key={pl.station} className="flex items-center justify-between gap-2">
                <span className="text-slate-300 text-xs truncate flex-1">{pl.station} ({pl.trackCount} track{pl.trackCount !== 1 ? 's' : ''})</span>
                <button
                  onClick={async () => {
                    const queueId = haConfig?.speakerQueues?.[master?.name] || haConfig?.queues?.airplayGroup;
                    setPandoraPlayStatus('Starting ' + pl.station + '...');
                    await maybeAdopt();
                    await onEstablishGroup(group.masterIp);
                    try {
                      const r = await fetch('/ha/pandora-play-playlist', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ stationName: pl.station, queueId }),
                      });
                      const d = await r.json();
                      setPandoraPlayStatus(d.ok ? pl.station + ' started' : 'Error: ' + (d.error || 'unknown'));
                    } catch (e) { setPandoraPlayStatus('Error: ' + e.message); }
                    setTimeout(() => setPandoraPlayStatus(null), 5000);
                  }}
                  className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded text-xs font-medium transition flex-shrink-0">
                  ▶ Play
                </button>
              </div>
            ))}
            {pandoraPlayStatus && <p className="text-indigo-300 text-xs mt-1 italic">{pandoraPlayStatus}</p>}
          </div>
        </div>
      )}

      {/* Home */}
      <div className="px-4 py-3 border-t border-slate-700/60">
        <h3 className="text-slate-400 text-xs font-semibold uppercase tracking-wider mb-2">Home</h3>
        <div className="flex gap-1.5 flex-wrap items-center">
          {haConfig?.releaseToTV?.includes(master?.name) && (<>
            <button onClick={() => {
                fetch(`/api/${group.masterIp}/select`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/xml' },
                  body: '<ContentItem source="PRODUCT" sourceAccount="TV"></ContentItem>',
                });
                fetch('/ha/release-to-tv', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ speakerName: master?.name }),
                });
              }}
              className="px-3 py-1.5 bg-slate-700 hover:bg-blue-800 text-slate-400 hover:text-white rounded-lg text-xs font-medium transition">
              📺 TV Input
            </button>
            <div className="w-px h-5 bg-slate-600 flex-shrink-0"/>
          </>)}
          <button onClick={async () => { await maybeAdopt(); onOpenNas(); }}
            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-xs font-medium transition">
            Browse
          </button>
          <div className="w-px h-5 bg-slate-600 flex-shrink-0"/>
          <button onClick={async () => { await maybeAdopt(); onPlayNasFolder(group.masterIp, "/volume1/music/_Children/GabbyCat"); }}
            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-xs font-medium transition">
            🪆 Gabby's
          </button>
        </div>
      </div>

      {/* Presets */}
      {master.presets && master.presets.length > 0 && !(isAirplay && group.speakers.some(s => s.brand === 'wiim')) && (
        <div className="px-4 py-3 border-t border-slate-700/60">
          <h3 className="text-slate-400 text-xs font-semibold uppercase tracking-wider mb-2">Bose Presets</h3>
          <div className="flex gap-1 flex-wrap">
            {master.presets.map(preset => (
              <button key={preset.id} onClick={async () => {
                await maybeAdopt();
                await onEstablishBoseZone(group.masterIp);
                onKey(group.masterIp, 'PRESET_' + preset.id);
              }}
                className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded text-xs font-medium">
                {preset.id === 1 ? 'Piazolla' : preset.name.replace(/ Radio$/i, '')}
              </button>
            ))}
          </div>
        </div>
      )}


      {/* MA library browser modal */}
      {radioBrowser && (
        <MABrowserModal
          speakerName={master?.name || group.masterIp}
          queueId={haConfig?.speakerQueues?.[master?.name] || haConfig?.queues?.airplayGroup}
          onClose={() => setRadioBrowser(false)}
          onBeforePlay={async () => { await maybeAdopt(); await onEstablishGroup(group.masterIp); }}
          onFilesystem={(fsUri) => {
            setRadioBrowser(false);
            const queueId = haConfig?.speakerQueues?.[master?.name];
            onOpenNas(undefined, { queueId, maFilesystemBase: fsUri });
          }}
        />
      )}

      {/* Sound settings modal */}
      {soundSettingsSpk && (
        <SoundSettingsModal
          ip={soundSettingsSpk.ip}
          speakerName={soundSettingsSpk.name}
          initialVolume={soundSettingsSpk.volume}
          onVolumeChange={onVolumeChange}
          onClose={() => setSoundSettingsSpk(null)}
        />
      )}

      {/* Album art modal */}
      {artModal && effectiveArt && (
        <div className="fixed inset-0 bg-black bg-opacity-90 flex items-center justify-center z-50"
             onClick={() => setArtModal(false)}>
          <img src={effectiveArt} alt="Album art"
               className="rounded-xl shadow-2xl object-contain"
               style={{ width: '70vmin', height: '70vmin' }}/>
        </div>
      )}
    </div>
  );
}

// ── TVCard ────────────────────────────────────────────────────────────────────
function TVCard({ tvState }) {
  if (!tvState || !tvState.on) return null;
  const { appleTV, appName } = tvState;
  const isApple = !!appleTV;

  return (
    <div className="bg-slate-800 rounded-2xl p-4 shadow-xl border border-slate-700 mb-3">
      <div className="flex items-center gap-3">
        {isApple && appleTV.art ? (
          <img src={appleTV.art} alt="art"
               className="w-16 h-16 rounded-lg object-cover flex-shrink-0" />
        ) : (
          <div className="w-16 h-16 rounded-lg bg-slate-700 flex items-center justify-center flex-shrink-0 text-2xl">
            {isApple ? '🍎' : '📺'}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-slate-400 text-xs font-medium">
              {isApple ? 'Apple TV' : 'Sunroom TV'}
            </span>
          </div>
          {isApple ? (
            <>
              {appleTV.title && (
                <p className="text-white font-semibold text-sm leading-tight truncate">{appleTV.title}</p>
              )}
              {appleTV.artist && (
                <p className="text-slate-400 text-xs truncate">{appleTV.artist}</p>
              )}
              {!appleTV.title && appleTV.app && (
                <p className="text-slate-300 text-sm truncate">{appleTV.app}</p>
              )}
            </>
          ) : (
            <p className="text-slate-300 text-sm truncate">{appName || tvState.source || 'On'}</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── AllSpeakersView ───────────────────────────────────────────────────────────
function AllSpeakersView() {
  const [speakerData, setSpeakerData] = useState({});
  const [speakers, setSpeakers] = useState(SPEAKERS);
  const [loading, setLoading]         = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [nasBrowser, setNasBrowser] = useState(null); // { ip, name }
  const [haConfig, setHaConfig] = useState(null);
  const [maGroups, setMaGroups] = useState([]);
  const [maTrackData, setMaTrackData] = useState({}); // speakerName → { track, artist, art }
  const [tvState, setTvState] = useState(null);
  const [pendingGroups, setPendingGroups] = useState({});
  const [removingMembers, setRemovingMembers] = useState(new Set());
  const removingMembersRef = useRef(new Set());
  const [showWholeHouse, setShowWholeHouse] = useState(false);
  const [wiimAlerts, setWiimAlerts] = useState([]); // [{ name, oldIp, newIp }]
  const [stopRestartByZone, setStopRestartByZone] = useState(() => {
    try { return JSON.parse(localStorage.getItem('stopRestartByZone') || '{}'); } catch { return {}; }
  });
  const wiimIpOverrides = useRef({}); // speakerName → override IP (persists across fetchSpeakers calls)
  const volumeTimers = useRef({});
  const deviceIds = useRef({});
  const prevSourceRef = useRef({});          // ip → last confirmed source (for transition detection)
  const speakerDataRef = useRef({});         // always-fresh speakerData for use inside setTimeout callbacks
  const autoTransitionTimers = useRef({});   // ip → debounce timer handle

  const fetchSpeakers = async () => {
    try {
      const res = await fetch('/speakers');
      if (!res.ok) return SPEAKERS;
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        // Discovery only finds Bose (port 8090) — always re-add non-Bose entries from constants.
        // Apply any session-local IP overrides (e.g. WiiM that moved to a new IP).
        const nonBose = SPEAKERS.filter(s => s.brand && s.brand !== 'bose').map(s => {
          const override = wiimIpOverrides.current[s.name];
          return override ? { ...s, ip: override } : s;
        });
        const merged = [...data, ...nonBose];
        setSpeakers(merged);
        return merged;
      }
    } catch (err) {
      console.warn('fetchSpeakers failed', err);
    }
    return SPEAKERS;
  };

  const applyWiimIpFix = (alert) => {
    wiimIpOverrides.current[alert.name] = alert.newIp;
    setSpeakers(prev => prev.map(s => s.name === alert.name ? { ...s, ip: alert.newIp } : s));
    setSpeakerData(prev => {
      const next = { ...prev };
      const old = next[alert.oldIp];
      if (old) { next[alert.newIp] = { ...old, ip: alert.newIp }; delete next[alert.oldIp]; }
      return next;
    });
    setWiimAlerts(prev => prev.filter(a => a.name !== alert.name));
  };

  const fetchMaGroups = () =>
    fetch('/ha/group-state').then(r => r.json()).then(d => {
      if (d.ok) setMaGroups(d.groups || []);
    }).catch(() => {});

  const pollAll = async (list = speakers) => {
    const speakerList = list.length ? list : SPEAKERS;
    const promises = speakerList.map(async (spk) => {
      const data = await fetchSpeakerData(spk);
      setSpeakerData(prev => ({ ...prev, [data.ip]: data }));
    });
    await Promise.all(promises);
    fetchMaGroups();
    setLastUpdated(new Date());
  };

  useEffect(() => {
    const load = async () => {
      setSpeakerData({});
      const discovered = await fetchSpeakers();
      await pollAll(discovered);
    };

    load();
    fetch('/ha/config').then(r => r.json()).then(setHaConfig).catch(() => {});
    fetchMaGroups();

    // Check for WiiMs that moved to new IPs since last deploy
    fetch('/wiim/discover').then(r => r.json()).then(d => {
      if (!d.scannedAt || !d.wiims) return;
      const foundIps = new Set(d.wiims.map(w => w.ip));
      const wiimSpeakers = SPEAKERS.filter(s => s.brand === 'wiim');
      const unknownIps = d.wiims.map(w => w.ip).filter(ip => !wiimSpeakers.some(s => s.ip === ip));
      const alerts = [];
      wiimSpeakers.forEach(spk => {
        if (!foundIps.has(spk.ip) && unknownIps.length > 0) {
          // Prefer candidate not already claimed by another alert
          const claimed = new Set(alerts.map(a => a.newIp));
          const candidate = unknownIps.find(ip => !claimed.has(ip));
          if (candidate) alerts.push({ name: spk.name, oldIp: spk.ip, newIp: candidate });
        }
      });
      if (alerts.length) setWiimAlerts(alerts);
    }).catch(() => {});
  }, []);

  // Fetch MA track metadata for AIRPLAY speakers (and AUX-redirect speakers) whenever speaker data updates
  useEffect(() => {
    if (!haConfig) return;
    // Build fromQueue→toQueue map for play redirects
    const redirectMap = {};
    (haConfig.playRedirects || []).forEach(r => { redirectMap[r.fromQueue] = r.toQueue; });

    Object.values(speakerData).forEach(spk => {
      const src = spk?.nowPlaying?.source;
      // Clear stale MA track data when speaker is no longer on AIRPLAY/AUX
      if (spk?.name && src !== 'AIRPLAY' && src !== 'AUX') {
        setMaTrackData(prev => { if (!prev[spk.name]) return prev; const next = { ...prev }; delete next[spk.name]; return next; });
        return;
      }
      if (!spk?.name || (src !== 'AIRPLAY' && src !== 'AUX')) return;
      const speakerQueue = haConfig.speakerQueues?.[spk.name];
      if (!speakerQueue) return;
      // For AUX: use the redirect target queue. For AIRPLAY: use the individual speaker queue.
      const queueId = src === 'AUX' ? redirectMap[speakerQueue] : speakerQueue;
      if (!queueId) return;
      fetch('/ha/queue-now-playing?queueId=' + queueId)
        .then(r => r.json())
        .then(d => {
          if (d.ok && (d.track || d.art)) {
            setMaTrackData(prev => ({ ...prev, [spk.name]: d }));
          } else if (src === 'AUX') {
            // AUX but nothing playing in MA — clear any stale track data
            setMaTrackData(prev => { const next = { ...prev }; delete next[spk.name]; return next; });
          }
        })
        .catch(() => {});
    });
  }, [speakerData, haConfig]);

  // Keep speakerDataRef current so setTimeout callbacks always see fresh data
  useEffect(() => { speakerDataRef.current = speakerData; });

  // Auto-transition groups when a leader's source crosses the AirPlay/native boundary.
  // Bose zone → AIRPLAY: dissolve zone, rejoin via MA. AIRPLAY → native: remove MA members, rebuild zone.
  useEffect(() => {
    if (!haConfig) return;
    for (const [ip, data] of Object.entries(speakerData)) {
      const cur = data?.nowPlaying?.source;
      if (!cur || cur === 'INVALID_SOURCE') continue;
      const prev = prevSourceRef.current[ip];
      prevSourceRef.current[ip] = cur;
      if (!prev || cur === prev) continue;

      const wasAirplay    = prev === 'AIRPLAY';
      const isNowAirplay  = cur  === 'AIRPLAY';
      if (wasAirplay === isNowAirplay) continue; // same grouping category, no transition needed

      const group = groups.find(g => g.masterIp === ip && g.speakers.length > 1);
      if (!group) continue;

      const leaderName = data.name;
      const memberIps  = group.speakers.filter(s => s.ip !== ip).map(s => s.ip);
      const maMembers  = group.maMembers || [];
      const queueId    = haConfig.speakerQueues?.[leaderName];
      console.log(`[autoTransition] ${leaderName}: ${prev} → ${cur} (${memberIps.length} members)`);

      clearTimeout(autoTransitionTimers.current[ip]);
      autoTransitionTimers.current[ip] = setTimeout(async () => {
        // Abort if source changed again during debounce
        if (speakerDataRef.current[ip]?.nowPlaying?.source !== cur) {
          console.log(`[autoTransition] ${leaderName}: source changed again, aborting`);
          return;
        }
        if (isNowAirplay) {
          await autoTransitionToMA(ip, leaderName, memberIps, queueId);
        } else {
          await autoTransitionToBose(ip, leaderName, maMembers);
        }
      }, 2000);
    }
  }, [speakerData, groups, haConfig]);

  useEffect(() => {
    const interval = setInterval(async () => {
      const discovered = await fetchSpeakers();
      await pollAll(discovered);
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  // Poll TV state every 10s
  useEffect(() => {
    const fetchTv = () =>
      fetch('/ha/tv-state').then(r => r.json()).then(d => { if (d.ok) setTvState(d.tv); }).catch(() => {});
    fetchTv();
    const interval = setInterval(fetchTv, 10000);
    return () => clearInterval(interval);
  }, []);

  const groups = useMemo(() => {
    if (!Object.keys(speakerData).length) return [];

    const speakerList = speakers.length ? speakers : SPEAKERS;

    // Build name→IP lookup
    const nameToIp = {};
    speakerList.forEach(s => { nameToIp[s.name] = s.ip; });

    // Collect Bose zones: masterIp → Set of all IPs in that zone
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

    // Merge MA groups: add MA members into leader's card, hide their standalone cards
    const maGroupedIps = new Set();
    maGroups.forEach(({ leader, members }) => {
      const leaderIp = nameToIp[leader];
      const leaderGroup = result.find(g => g.masterIp === leaderIp);
      if (!leaderGroup) return;
      const maMembers = members
        .map(name => speakerData[nameToIp[name]])
        .filter(Boolean);
      maMembers.forEach(m => {
        maGroupedIps.add(m.ip);
        if (!leaderGroup.speakers.find(s => s.ip === m.ip))
          leaderGroup.speakers.push(m);
      });
      leaderGroup.maMembers = members; // track which speakers are MA (not Bose) members
    });

    // Remove any card whose master IP is an MA group member (absorbed into leader)
    const merged = result.filter(g => !maGroupedIps.has(g.masterIp));

    // Detect phantom groups: standalone speakers playing the same AirPlay track in sync
    const phantomGroupedIps = new Set();
    const trackBuckets = {};
    merged.forEach(g => {
      if (g.speakers.length !== 1) return;
      if (removingMembersRef.current.has(g.speakers[0].name)) return; // mid-removal: don't re-absorb into phantom
      const np = g.speakers[0].nowPlaying;
      if (!np || np.source !== 'AIRPLAY' || !np.track || !np.artist) return;
      const key = `${np.artist}|${np.track}`;
      (trackBuckets[key] = trackBuckets[key] || []).push(g);
    });
    Object.values(trackBuckets).forEach(bucket => {
      if (bucket.length < 2) return;
      const positions = bucket.map(g => g.speakers[0].nowPlaying?.position ?? 0);
      const anyNonZero = positions.some(p => p > 0);
      if (anyNonZero) {
        const base = positions[0];
        if (!positions.every(p => Math.abs(p - base) < 15)) return;
      }
      const leader = bucket[0];
      leader.phantomGroup = true;
      leader.phantomMembers = bucket.slice(1).map(g => g.speakers[0].name);
      bucket.slice(1).forEach(g => {
        phantomGroupedIps.add(g.masterIp);
        g.speakers.forEach(s => { if (!leader.speakers.find(ls => ls.ip === s.ip)) leader.speakers.push(s); });
      });
    });
    const finalMerged = merged.filter(g => !phantomGroupedIps.has(g.masterIp));

    // Sort: active multi-speaker groups first, then solo playing, then idle.
    // Within each tier, preserve SPEAKERS constant order.
    const ipOrder = {};
    SPEAKERS.forEach((s, i) => { ipOrder[s.ip] = i; });
    const groupRank = g => Math.min(...g.speakers.map(s => ipOrder[s.ip] ?? 999));
    const isGroupActive = g => g.speakers.some(s =>
      s.playStatus === 'PLAY_STATE' ||
      (s.nowPlaying?.source && s.nowPlaying.source !== 'STANDBY' && s.nowPlaying.source !== 'INVALID_SOURCE')
    );
    finalMerged.sort((a, b) => {
      const aMulti = a.speakers.length > 1 ? 0 : 1;
      const bMulti = b.speakers.length > 1 ? 0 : 1;
      if (aMulti !== bMulti) return aMulti - bMulti;
      const aActive = isGroupActive(a) ? 0 : 1;
      const bActive = isGroupActive(b) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return groupRank(a) - groupRank(b);
    });

    return finalMerged;
  }, [speakerData, maGroups]);

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
    setPendingGroups(prev => {
      const next = {};
      for (const [k, v] of Object.entries(prev)) { const s = new Set(v); s.delete(removeIp); if (s.size) next[k] = s; }
      return next;
    });
    setTimeout(pollAll, 1200);
  };

  const onVolumeChange = (ip, level, immediate = false) => {
    setSpeakerData(prev => ({ ...prev, [ip]: { ...prev[ip], volume: level } }));
    if (speakerData[ip]?.brand === 'wiim') {
      clearTimeout(volumeTimers.current[ip]);
      const send = () => fetch('/wiim/volume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip, volume: level }) });
      if (immediate) send();
      else volumeTimers.current[ip] = setTimeout(send, 250);
      return;
    }
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
    if (current.brand === 'wiim') {
      fetch('/wiim/mute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip, muted: newMuted }) });
      return;
    }
    apiPost(ip, '/volume', '<volume>' + current.volume + '<muteenabled>' + newMuted + '</muteenabled></volume>');
  };

  const onKey = (ip, key) => {
    if (speakerData[ip]?.brand === 'wiim') {
      const wiimSrc = speakerData[ip]?.nowPlaying?.source;
      const wiimName = speakerData[ip]?.name;
      const wiimQueue = haConfig?.speakerQueues?.[wiimName];
      if (key === 'NEXT_TRACK' || key === 'PREV_TRACK') {
        fetch(key === 'NEXT_TRACK' ? '/upnp/queue/skip' : '/upnp/queue/prev', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ speakerIp: ip }),
        });
      } else if (key === 'PLAY_PAUSE' && wiimSrc === 'AIRPLAY') {
        if (wiimQueue) {
          const isPlaying = speakerData[ip]?.playStatus === 'PLAY_STATE';
          fetch(isPlaying ? '/ha/pause' : '/ha/resume', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ queueId: wiimQueue }),
          });
          setTimeout(pollAll, 800);
        }
      } else if (key === 'POWER') {
        if (wiimSrc === 'AIRPLAY' && wiimQueue) {
          fetch('/ha/stop',  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queueId: wiimQueue }) });
          fetch('/ha/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queueId: wiimQueue }) });
        } else {
          fetch('/wiim/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip, key: 'PLAY_PAUSE' }) });
        }
        setTimeout(pollAll, 1000);
      } else {
        fetch('/wiim/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip, key }) });
        setTimeout(pollAll, 800);
      }
      return;
    }
    // When powering off a speaker playing via MA/AirPlay:
    // - If it's a group MEMBER (not leader): only ungroup it, don't stop the queue (leader keeps playing)
    // - If it's the group LEADER or playing solo: stop+clear so HA won't auto-restart
    if (key === 'POWER') {
      const src = speakerData[ip]?.nowPlaying?.source;
      const name = speakerData[ip]?.name;
      const speakerQueue = name && haConfig?.speakerQueues?.[name];
      const redirectMap = {};
      (haConfig?.playRedirects || []).forEach(r => { redirectMap[r.fromQueue] = r; });
      const isAuxRedirect = src === 'AUX' && speakerQueue && redirectMap[speakerQueue];

      if (src === 'AIRPLAY' || isAuxRedirect) {
        const isGroupMember = maGroups.some(g => g.members && g.members.includes(name));
        if (!isGroupMember && src === 'AIRPLAY') {
          // Solo or group leader — stop+clear so HA won't auto-restart playback
          const airplayGroupId = haConfig?.queues?.airplayGroup;
          const queuesToKill = [...new Set([speakerQueue, airplayGroupId].filter(Boolean))];
          queuesToKill.forEach(queueId => {
            fetch('/ha/stop',  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queueId }) });
            fetch('/ha/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queueId }) });
          });
        }
        // Always ungroup so the UI card separates and MA releases the speaker
        if (name) {
          fetch('/ha/group-remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speakerName: name }) })
            .then(() => setTimeout(() => fetchMaGroups(), 1500))
            .catch(() => {});
        }
      }
    }
    // When playing via UPnP, NEXT/PREV must go through our queue, not the Bose key API
    if (key === 'NEXT_TRACK' || key === 'PREV_TRACK') {
      const src = speakerData[ip]?.nowPlaying?.source;
      if (src === 'LOCAL_INTERNET_RADIO' || src === 'UPNP' || src === 'UPnP') {
        const endpoint = key === 'NEXT_TRACK' ? '/upnp/queue/skip' : '/upnp/queue/prev';
        fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ speakerIp: ip }),
        });
        return;
      }
      if (src === 'AIRPLAY' || src === 'AUX') {
        const name = speakerData[ip]?.name;
        const speakerQueue = name && haConfig?.speakerQueues?.[name];
        // For AUX redirect, skip on the redirected (Belkin) queue; for AIRPLAY use speaker/group queue
        const redirectMap = {};
        (haConfig?.playRedirects || []).forEach(r => { redirectMap[r.fromQueue] = r.toQueue; });
        const queueId = (src === 'AUX' && speakerQueue && redirectMap[speakerQueue])
          || speakerQueue
          || haConfig?.queues?.airplayGroup;
        if (queueId) {
          // WORKAROUND: MA next-track is broken for Pandora; signal server to use pause→play instead.
          // Remove pandora flag once MA fixes native next-track support for Pandora radio.
          const isPandoraNext = key === 'NEXT_TRACK' && maTrackData[name]?.provider === 'pandora';
          fetch(key === 'NEXT_TRACK' ? '/ha/next' : '/ha/prev', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(isPandoraNext ? { queueId, pandora: true } : { queueId }),
          });
          return;
        }
      }
    }
    apiPost(ip, '/key', '<key state="press" sender="Gabbo">' + key + '</key>');
    setTimeout(() => apiPost(ip, '/key', '<key state="release" sender="Gabbo">' + key + '</key>'), 100);
    if (key === 'PLAY_PAUSE' || key.startsWith('PRESET_')) setTimeout(pollAll, 800);
    if (key === 'POWER') setTimeout(pollAll, 1500);
  };

  const onMaGroupRemove = (speakerName) => {
    // Populate phantom guard and spinner synchronously in the event batch
    removingMembersRef.current.add(speakerName);
    setRemovingMembers(prev => new Set([...prev, speakerName]));
    (async () => {
      await fetch('/ha/group-remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speakerName }),
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      await fetchMaGroups();
      // Keep removingMembers active through pollAll — standalone card stays grey until
      // speakerData is fresh and the card has settled in its final sort position
      await pollAll();
      removingMembersRef.current.delete(speakerName);
      setRemovingMembers(prev => { const s = new Set(prev); s.delete(speakerName); return s; });
    })();
  };

  const adoptPhantomGroup = async (group) => {
    const leaderName = group.speakers[0]?.name;
    const memberNames = group.phantomMembers || [];
    if (!leaderName || !memberNames.length || !haConfig?.speakerEntities?.[leaderName]) return;
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const wiimIps = group.speakers.filter(s => s.brand === 'wiim').map(s => s.ip);
    if (wiimIps.length) await Promise.allSettled(wiimIps.map(ip => post('/wiim/ungroup', { ip })));
    await post('/ha/group-include', { masterName: leaderName, speakerNames: memberNames });
    setTimeout(() => { fetchMaGroups(); pollAll(); }, 1500);
  };

  // Dissolve Bose zone then add all members to MA AirPlay group (native → AirPlay transition)
  const autoTransitionToMA = async (leaderIp, leaderName, memberIps, queueId) => {
    console.log(`[autoTransition] ${leaderName}: dissolving Bose zone, joining ${memberIps.length} members via MA`);
    const masterDeviceId = await getDeviceId(leaderIp).catch(() => null);
    if (masterDeviceId) {
      for (const memberIp of memberIps) {
        const devId = await getDeviceId(memberIp).catch(() => null);
        if (!devId) continue;
        const xml = `<?xml version="1.0" encoding="UTF-8"?><zone master="${masterDeviceId}"><member ipaddress="${memberIp}">${devId}</member></zone>`;
        await apiPost(leaderIp, '/removeZoneSlave', xml).catch(() => {});
      }
    }
    await new Promise(r => setTimeout(r, 500));
    for (const memberIp of memberIps) {
      const memberName = speakerDataRef.current[memberIp]?.name;
      if (!memberName) continue;
      await joinToGroup(leaderIp, memberIp, leaderName, memberName, queueId).catch(() => {});
    }
  };

  // Remove members from MA group then rebuild Bose zone (AirPlay → native transition)
  const autoTransitionToBose = async (leaderIp, leaderName, maMembers) => {
    console.log(`[autoTransition] ${leaderName}: removing MA group, rebuilding Bose zone for ${maMembers.length} members`);
    for (const memberName of maMembers) {
      await fetch('/ha/group-remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speakerName: memberName }),
      }).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 500));
    const memberIps = maMembers
      .map(name => Object.values(speakerDataRef.current).find(s => s.name === name)?.ip)
      .filter(Boolean);
    if (!memberIps.length) { setTimeout(() => { fetchMaGroups(); pollAll(); }, 500); return; }
    const masterDeviceId = await getDeviceId(leaderIp).catch(() => null);
    if (!masterDeviceId) return;
    const memberData = await Promise.all(memberIps.map(async ip => ({
      ip, deviceId: await getDeviceId(ip).catch(() => null),
    })));
    const valid = memberData.filter(m => m.deviceId);
    if (!valid.length) return;
    const membersXml = valid.map(m => `<member ipaddress="${m.ip}">${m.deviceId}</member>`).join('');
    const xml = `<?xml version="1.0" encoding="UTF-8"?><zone master="${masterDeviceId}" senderIPAddress="${leaderIp}">${membersXml}</zone>`;
    await apiPost(leaderIp, '/setZone', xml).catch(e => console.warn('[autoTransition] setZone failed:', e));
    setTimeout(() => { fetchMaGroups(); pollAll(); }, 1000);
  };

  const onMaStop = (speakerIp) => {
    const name = speakerData[speakerIp]?.name;
    const queueId = (name && haConfig?.speakerQueues?.[name]) || haConfig?.queues?.airplayGroup;
    if (!queueId) return;
    fetch('/ha/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queueId }),
    }).then(() => setTimeout(pollAll, 1000));
  };

  const joinToGroup = async (leaderIp, memberIp, leaderName, memberName, queueId) => {
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    // Dissolve native WiiM multiroom first so WiiM responds to AirPlay grouping correctly.
    const wiimsToUngroup = [leaderIp, memberIp].filter(wip => speakerData[wip]?.brand === 'wiim');
    if (wiimsToUngroup.length > 0) {
      await Promise.allSettled(wiimsToUngroup.map(wip => post('/wiim/ungroup', { ip: wip })));
    }

    // Join while playing — MA set_members should extend the live AirPlay session.
    try {
      const res = await post('/ha/group-include', { masterName: leaderName, speakerNames: [memberName] });
      const d = await res.json();
      console.log('[joinToGroup] group-include result:', JSON.stringify(d));
      if (!d.ok) console.error('[joinToGroup] group-include failed:', d.error);
    } catch (e) { console.warn('[joinToGroup] error:', e); }

    // After join, verify MA group state
    try {
      const r = await fetch('/ha/ma-players');
      const d = await r.json();
      console.log('[joinToGroup] MA players after join:', JSON.stringify(d.players));
    } catch {}

    await new Promise(resolve => setTimeout(resolve, 100));
    await fetchMaGroups();
    await pollAll();
  };

  const joinSpeakerNow = async (leaderIp, memberIp) => {
    const leaderName = speakerData[leaderIp]?.name;
    const memberName = speakerData[memberIp]?.name;
    const leaderSource = speakerData[leaderIp]?.nowPlaying?.source;
    const hasWiiM = speakerData[memberIp]?.brand === 'wiim' || speakerData[leaderIp]?.brand === 'wiim';

    const hasMAEntity = !!(leaderName && haConfig?.speakerEntities?.[leaderName]);
    // Use MA grouping only when the source is AIRPLAY (MA is managing playback).
    // All native Bose sources (UPNP, BLUETOOTH, LOCAL_INTERNET_RADIO, etc.) use zone grouping.
    if (hasMAEntity && memberName && leaderSource === 'AIRPLAY') {
      const queueId = haConfig?.speakerQueues?.[leaderName];
      return await joinToGroup(leaderIp, memberIp, leaderName, memberName, queueId)
        .then(() => null)
        .catch(e => e.message);
    } else if (leaderName && !hasMAEntity) {
      console.warn('[joinSpeakerNow] no HA entity for leader:', leaderName);
    }
    // Bose zone grouping for all non-AIRPLAY sources and speakers without MA entity
    if (!hasWiiM && (leaderSource !== 'AIRPLAY' || !hasMAEntity)) {
      await addSpeakerToGroup(leaderIp, memberIp);
    }
    setTimeout(() => { fetchMaGroups(); pollAll(); }, 1200);
    return null;
  };

  const toggleStopRestart = (masterIp) => {
    setStopRestartByZone(prev => {
      const next = { ...prev, [masterIp]: prev[masterIp] === false ? true : false };
      try { localStorage.setItem('stopRestartByZone', JSON.stringify(next)); } catch {}
      return next;
    });
  };

  const togglePendingMember = (leaderIp, memberIp) => {
    setPendingGroups(prev => {
      const current = new Set(prev[leaderIp] || []);
      if (current.has(memberIp)) current.delete(memberIp);
      else current.add(memberIp);
      const next = { ...prev };
      if (current.size === 0) delete next[leaderIp];
      else next[leaderIp] = current;
      return next;
    });
  };

  const establishGroup = async (leaderIp) => {
    const members = pendingGroups[leaderIp];
    if (!members || members.size === 0) return;
    const memberIps = [...members];
    const leaderName = speakerData[leaderIp]?.name;
    const memberNames = memberIps.map(ip => speakerData[ip]?.name).filter(Boolean);

    // Set up MA/AirPlay group only — no Bose zone here.
    // Bose zone setup while on AirPlay interferes with subsequent dynamic adds (MA restart
    // rebuilds the AirPlay session, dropping any speakers added after initial group formation).
    // For NAS/UPnP, joinSpeakerNow handles Bose zone via addSpeakerToGroup once playing.
    if (leaderName && haConfig?.speakerEntities?.[leaderName] && memberNames.length > 0) {
      await fetch('/ha/group-include', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ masterName: leaderName, speakerNames: memberNames }),
      }).catch(e => console.warn('[establishGroup] MA join error:', e));
    }

    // Update group display after setup (play functions own the pollAll timing)
    setTimeout(fetchMaGroups, 2000);
  };

  // Establish a Bose SoundTouch zone from pending group members — used for NAS/UPnP/preset play.
  // Does NOT call MA join (that would switch speakers to AirPlay and break UPnP sync).
  // WiiM speakers are skipped — they cannot join a SoundTouch zone.
  const establishBoseZone = async (leaderIp) => {
    const members = pendingGroups[leaderIp];
    if (!members || members.size === 0) return;
    const memberIps = [...members].filter(ip => speakerData[ip]?.brand !== 'wiim');
    if (memberIps.length === 0) return;
    const masterDeviceId = await getDeviceId(leaderIp);
    if (!masterDeviceId) return;
    const memberData = await Promise.all(memberIps.map(async ip => ({
      ip, deviceId: await getDeviceId(ip),
    })));
    const valid = memberData.filter(m => m.deviceId);
    if (!valid.length) return;
    const membersXml = valid.map(m => '<member ipaddress="' + m.ip + '">' + m.deviceId + '</member>').join('');
    const xml = '<?xml version="1.0" encoding="UTF-8"?>' +
      '<zone master="' + masterDeviceId + '" senderIPAddress="' + leaderIp + '">' + membersXml + '</zone>';
    await apiPost(leaderIp, '/setZone', xml);
    setTimeout(() => { fetchMaGroups(); pollAll(); }, 1500);
  };

  const playNasFolder = async (speakerIp, folderPath) => {
    await establishBoseZone(speakerIp);
    try {
      const { base: serverBase } = await fetch('/serverInfo').then(r => r.json());
      const data = await fetch('/nas/browse?path=' + encodeURIComponent(folderPath)).then(r => r.json());
      const files = data.files || [];
      if (!files.length) return;
      const base = folderPath.replace(/\/$/, '');
      const artUrl = data.artFile
        ? serverBase + '/nas/art?path=' + encodeURIComponent(base + '/' + data.artFile)
        : null;
      const tracks = files.map(f => ({
        url: serverBase + '/nas/stream?path=' + encodeURIComponent(base + '/' + f),
        title: f.replace(/\.[^.]+$/, ''),
        artUrl,
      }));
      await fetch('/upnp/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speakerIp, tracks }),
      });
    } catch (e) {
      console.error('playNasFolder error:', e);
    }
  };

  const playFavorite = async (fav, queueId, leaderIp) => {
    if (leaderIp) await establishGroup(leaderIp);
    const targetQueue = queueId || fav.defaultQueueId;
    const res = await fetch('/ha/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queueId: targetQueue, uri: fav.uri }),
    });
    const d = await res.json();
    if (d.ok) {
      // Poll twice: first at 3s to update play state, again at 6s to catch MA track metadata
      setTimeout(pollAll, 3000);
      setTimeout(pollAll, 6000);
    }
    return d;
  };

  const powerOffAll = () => {
    const activeMasters = groups
      .filter(g => {
        const m = g.speakers.find(s => s.ip === g.masterIp) || g.speakers[0];
        return m?.reachable && m?.nowPlaying?.source !== 'STANDBY' && m?.nowPlaying;
      })
      .map(g => g.masterIp);
    activeMasters.forEach(ip => onKey(ip, 'POWER'));
    if (activeMasters.length) setTimeout(pollAll, 1500);
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
        <div className="flex items-start justify-between mb-5">
          <div>
            <BoomBoxIcon size={80}/>
            <p className="text-slate-500 text-xs mt-0.5">
              {lastUpdated ? 'Updated ' + lastUpdated.toLocaleTimeString() : 'Scanning speakers... (' + Object.keys(speakerData).length + '/' + speakers.length + ')'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 justify-end ml-4">
            {haConfig && (() => {
              const haUrl = haConfig.haUrl || 'http://homeassistant:8123';
              const maUrl = haUrl.replace(':8123', ':8095');
              return (<>
                <a href={maUrl} target="_blank" rel="noreferrer"
                  className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white rounded-lg text-xs transition">
                  Music Assistant
                </a>
                <a href={haUrl} target="_blank" rel="noreferrer"
                  className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white rounded-lg text-xs transition">
                  Home Assistant
                </a>
              </>);
            })()}
            <a href="/tests.html" target="_blank" rel="noreferrer"
              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white rounded-lg text-xs transition">
              Tests
            </a>
            {haConfig?.features?.wholeHouseOverview && (
              <button onClick={() => setShowWholeHouse(true)}
                title="All rooms overview"
                className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white rounded-lg text-xs transition">
                ⊞ Rooms
              </button>
            )}
            <button onClick={() => window.location.reload()}
              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white rounded-lg text-xs transition">
              Refresh
            </button>
            <button onClick={powerOffAll}
              title="Power off all speakers"
              className="px-3 py-1.5 bg-slate-700 hover:bg-red-700 text-slate-300 hover:text-white rounded-lg text-xs transition">
              ⏻ All Off
            </button>
          </div>
        </div>

        {/* TV card */}
        <TVCard tvState={tvState} />

        {/* WiiM IP change alerts */}
        {wiimAlerts.map(alert => (
          <div key={alert.name} className="mx-3 mb-1 px-3 py-2 bg-amber-900/30 border border-amber-700/40 rounded-lg flex items-center justify-between gap-3">
            <span className="text-amber-200 text-xs">
              <span className="font-medium">{alert.name}</span> moved to {alert.newIp}
            </span>
            <div className="flex gap-1.5 flex-shrink-0">
              <button onClick={() => applyWiimIpFix(alert)}
                className="px-2 py-1 bg-amber-700 hover:bg-amber-600 text-white rounded text-xs transition">
                Use {alert.newIp}
              </button>
              <button onClick={() => setWiimAlerts(prev => prev.filter(a => a.name !== alert.name))}
                className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded text-xs transition">
                Dismiss
              </button>
            </div>
          </div>
        ))}

        {/* Speaker groups */}
        <div className="space-y-3">
          {groups.map(group => {
            const master = group.speakers.find(s => s.ip === group.masterIp) || group.speakers[0];
            return (
              <GroupCard key={group.id} group={group}
                onVolumeChange={onVolumeChange} onMute={onMute} onKey={onKey}
                onRemoveFromGroup={removeSpeakerFromGroup}
                otherSpeakers={speakers.filter(s => !group.speakers.some(gs => gs.ip === s.ip))}
                speakerData={speakerData}
                groups={groups}
                onOpenNas={(path, opts) => setNasBrowser({ ip: group.masterIp, name: master?.name || group.masterIp, initialPath: path, ...(opts || {}) })}
                onPlayNasFolder={playNasFolder}
                onMaStop={onMaStop}
                onMaGroupRemove={onMaGroupRemove}
                removingMembers={removingMembers}
                haConfig={haConfig}
                onPlayFavorite={playFavorite}
                maTrack={maTrackData[master?.name]}
                pendingGroups={pendingGroups}
                onTogglePendingMember={togglePendingMember}
                onEstablishGroup={establishGroup}
                onEstablishBoseZone={establishBoseZone}
                onJoinNow={joinSpeakerNow}
                onAdoptPhantomGroup={adoptPhantomGroup}
                stopRestartEnabled={stopRestartByZone[group.masterIp] !== false}
                onToggleStopRestart={() => toggleStopRestart(group.masterIp)}
              />
            );
          })}
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

      {showWholeHouse && (
        <WholeHouseView
          speakerData={speakerData}
          maGroups={maGroups}
          maTrackData={maTrackData}
          onClose={() => setShowWholeHouse(false)}
        />
      )}

      {nasBrowser && (
        <NasBrowserModal
          speakerIp={nasBrowser.ip}
          speakerName={nasBrowser.name}
          initialPath={nasBrowser.initialPath}
          queueId={nasBrowser.queueId}
          maFilesystemBase={nasBrowser.maFilesystemBase}
          onClose={() => setNasBrowser(null)}
          onBeforePlay={() => nasBrowser.queueId ? Promise.resolve() : establishBoseZone(nasBrowser.ip)}
        />
      )}
    </div>
  );
}

ReactDOM.render(<AllSpeakersView/>, document.getElementById('root'));
