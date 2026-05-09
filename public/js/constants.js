const { useState, useEffect, useRef } = React;

const SPEAKERS = [
  { ip: '192.168.1.229', name: 'Bose-Sunroom 300' },
  { ip: '192.168.1.170', name: 'Bose-Living Room' },
  { ip: '192.168.1.185', name: 'Bose-Kitchen' },
  { ip: '192.168.1.161', name: 'Bose-Office' },
  { ip: '192.168.1.40',  name: 'Bose-Rosemary' },
  { ip: '192.168.1.92',  name: 'Bose-Joshua' },
  { ip: '192.168.1.176', name: 'Bose-Bedroom' },
  { ip: '192.168.1.55',  name: 'Bose-Dining Room' },
  { ip: '192.168.1.7',   name: 'Bose-Patio' },
  { ip: '192.168.1.245', name: 'Bose-Bathroom' },
  { ip: '192.168.1.112', name: 'WiiM Basement', brand: 'wiim' },
  { ip: '192.168.1.9',   name: 'WiiM Joshua',   brand: 'wiim' },
  { ip: '192.168.1.139', name: 'WiiM Rosemary',  brand: 'wiim' },
];

const REPEAT_CYCLE = ['REPEAT_OFF', 'REPEAT_ONE', 'REPEAT_ALL'];
