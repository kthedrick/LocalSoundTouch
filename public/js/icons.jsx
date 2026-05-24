const Icon = ({ d, children, size = 20, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="2" strokeLinecap="round"
       strokeLinejoin="round" {...props}>
    {d ? <path d={d}/> : children}
  </svg>
);

const SpeakerIcon = () => <Icon><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></Icon>;
const PlayIcon    = () => <Icon><polygon points="5 3 19 12 5 21 5 3"/></Icon>;
const PauseIcon   = () => <Icon><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></Icon>;
const PrevIcon    = () => <Icon><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/></Icon>;
const NextIcon    = () => <Icon><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></Icon>;
const PowerIcon   = () => <Icon><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></Icon>;
const VolumeIcon  = () => <Icon><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></Icon>;
const MuteIcon    = () => <Icon><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></Icon>;
const ShuffleIcon = () => <Icon><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/></Icon>;
const RepeatIcon  = () => <Icon><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></Icon>;
const SourceIcon  = () => <Icon><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/></Icon>;
const BassIcon       = () => <Icon><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></Icon>;
const QueueIcon      = ({ size = 20 }) => <Icon size={size}><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></Icon>;
const ChevronDownIcon = ({ size = 20 }) => <Icon size={size}><polyline points="6 9 12 15 18 9"/></Icon>;

const BoomBoxIcon = ({ size = 64 }) => (
  <svg width={size} height={size * 0.6} viewBox="0 0 120 72" fill="none" xmlns="http://www.w3.org/2000/svg">
    {/* Antenna left */}
    <line x1="30" y1="8" x2="22" y2="0" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round"/>
    {/* Antenna right */}
    <line x1="90" y1="8" x2="98" y2="0" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round"/>
    {/* Body */}
    <rect x="8" y="8" width="104" height="56" rx="6" fill="#1e293b" stroke="#475569" strokeWidth="1.5"/>
    {/* Handle */}
    <path d="M42 8 Q60 1 78 8" stroke="#475569" strokeWidth="2" fill="none" strokeLinecap="round"/>
    {/* Left speaker grille */}
    <circle cx="26" cy="36" r="14" fill="#0f172a" stroke="#334155" strokeWidth="1.5"/>
    <circle cx="26" cy="36" r="9" fill="#1e293b" stroke="#475569" strokeWidth="1"/>
    <circle cx="26" cy="36" r="4" fill="#334155"/>
    {/* Right speaker grille */}
    <circle cx="94" cy="36" r="14" fill="#0f172a" stroke="#334155" strokeWidth="1.5"/>
    <circle cx="94" cy="36" r="9" fill="#1e293b" stroke="#475569" strokeWidth="1"/>
    <circle cx="94" cy="36" r="4" fill="#334155"/>
    {/* Center panel */}
    <rect x="46" y="14" width="28" height="16" rx="2" fill="#0f172a" stroke="#334155" strokeWidth="1"/>
    {/* Cassette window */}
    <rect x="48" y="16" width="24" height="12" rx="1.5" fill="#1e293b"/>
    <ellipse cx="54" cy="22" rx="3.5" ry="3" fill="#0f172a" stroke="#475569" strokeWidth="0.8"/>
    <ellipse cx="66" cy="22" rx="3.5" ry="3" fill="#0f172a" stroke="#475569" strokeWidth="0.8"/>
    <line x1="57.5" y1="22" x2="62.5" y2="22" stroke="#475569" strokeWidth="0.8"/>
    {/* Buttons row */}
    <rect x="47" y="34" width="5" height="4" rx="1" fill="#ef4444"/>
    <rect x="54" y="34" width="5" height="4" rx="1" fill="#334155"/>
    <rect x="61" y="34" width="5" height="4" rx="1" fill="#334155"/>
    <rect x="68" y="34" width="5" height="4" rx="1" fill="#334155"/>
    {/* Volume knob */}
    <circle cx="52" cy="46" r="4" fill="#0f172a" stroke="#475569" strokeWidth="1"/>
    <circle cx="52" cy="46" r="1.5" fill="#475569"/>
    {/* Tuner knob */}
    <circle cx="68" cy="46" r="4" fill="#0f172a" stroke="#475569" strokeWidth="1"/>
    <circle cx="68" cy="46" r="1.5" fill="#475569"/>
    {/* EQ lights */}
    <rect x="47" y="54" width="3" height="4" rx="0.5" fill="#22c55e"/>
    <rect x="51" y="55" width="3" height="3" rx="0.5" fill="#22c55e"/>
    <rect x="55" y="54" width="3" height="4" rx="0.5" fill="#eab308"/>
    <rect x="59" y="55" width="3" height="3" rx="0.5" fill="#eab308"/>
    <rect x="63" y="53" width="3" height="5" rx="0.5" fill="#f97316"/>
    <rect x="67" y="55" width="3" height="3" rx="0.5" fill="#22c55e"/>
    <rect x="71" y="54" width="3" height="4" rx="0.5" fill="#22c55e"/>
  </svg>
);
