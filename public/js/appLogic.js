// Pure UI logic shared between the browser (window.AppLogic) and node:test.
// No React, no globals — extracted from app2.jsx so it can be unit-tested.

(function () {
  'use strict';

  // mm:ss from seconds
  function formatTime(s) {
    const n = Math.max(0, Math.floor(s));
    return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
  }

  // fromQueue → full playRedirects entry (callers pick .toQueue as needed)
  function buildRedirectMap(playRedirects) {
    const map = {};
    (playRedirects || []).forEach(r => { map[r.fromQueue] = r; });
    return map;
  }

  // Build display group cards from speaker/zone/MA/phantom state.
  // Params:
  //   speakerData      ip → speaker state ({ ip, name, playStatus, nowPlaying, zoneInfo, ... })
  //   speakers         discovered speaker list [{ name, ip }]
  //   defaultSpeakers  fallback speaker list (the SPEAKERS constant)
  //   maGroups         [{ leader, members }] from /ha/group-state
  //   sessionOrder     usage-ranked speaker names, or null
  //   removingMembers  Set of names mid-removal (phantom guard)
  function computeGroups({ speakerData, speakers, defaultSpeakers, maGroups, sessionOrder, removingMembers }) {
    if (!Object.keys(speakerData).length) return [];

    const speakerList = speakers.length ? speakers : defaultSpeakers;

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
      if (removingMembers.has(g.speakers[0].name)) return; // mid-removal: don't re-absorb into phantom
      // Stopped speakers keep stale last-track metadata (WiiM does this) — only
      // actively-playing speakers can form a phantom group.
      if (g.speakers[0].playStatus !== 'PLAY_STATE') return;
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
    // Within each tier, use session-computed frequency order (falls back to defaultSpeakers order).
    const ipOrder = {};
    const orderedNames = sessionOrder || defaultSpeakers.map(s => s.name);
    orderedNames.forEach((name, i) => {
      const spk = speakers.find(s => s.name === name);
      if (spk) ipOrder[spk.ip] = i;
    });
    const groupRank = g => ipOrder[g.masterIp] ?? 999;

    finalMerged.sort((a, b) => groupRank(a) - groupRank(b));

    return finalMerged;
  }

  const AppLogic = { formatTime, buildRedirectMap, computeGroups };
  if (typeof module !== 'undefined' && module.exports) module.exports = AppLogic;
  if (typeof window !== 'undefined') window.AppLogic = AppLogic;
})();
