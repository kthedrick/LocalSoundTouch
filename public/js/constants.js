const { useState, useEffect, useRef } = React;

const SPEAKERS = [
  { ip: '192.168.1.229', name: 'Bose-Sunroom 300' },
  { ip: '192.168.1.171', name: 'Bose-Living Room' },
  { ip: '192.168.1.185', name: 'Bose-Kitchen' },
  { ip: '192.168.1.162', name: 'Bose-Office' },
  { ip: '192.168.1.120', name: 'Bose-Bathroom' },
  { ip: '192.168.1.40',  name: 'Bose-Rosemary' },
  { ip: '192.168.1.91',  name: 'Bose-Joshua' },
  { ip: '192.168.1.176', name: 'Bose-Bedroom' },
  { ip: '192.168.1.55',  name: 'Bose-Dining Room' },
  { ip: '192.168.1.7',   name: 'Bose-Patio' },
];

const REPEAT_CYCLE = ['REPEAT_OFF', 'REPEAT_ONE', 'REPEAT_ALL'];
