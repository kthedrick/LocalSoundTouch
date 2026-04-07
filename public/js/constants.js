const { useState, useEffect, useRef } = React;

const SPEAKERS = [
  { ip: '192.168.1.229', name: 'Sunroom' },
  { ip: '192.168.1.171', name: 'Living Room' },
  { ip: '192.168.1.185', name: 'Kitchen' },
  { ip: '192.168.1.164', name: 'Office' },
  { ip: '192.168.1.247', name: 'Bathroom' },
  { ip: '192.168.1.36', name: 'Rosemary' },
  { ip: '192.168.1.94', name: 'Joshua' },
  { ip: '192.168.1.176', name: 'Main Bedroom' },
  { ip: '192.168.1.62', name: 'Dining Room' },
  { ip: '192.168.1.13', name: 'Patio' }
];

const REPEAT_CYCLE = ['REPEAT_OFF', 'REPEAT_ONE', 'REPEAT_ALL'];
