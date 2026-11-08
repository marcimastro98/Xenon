// Invented state for the tiles that reach into the house or a paired device: smart
// home, cameras, file transfer, phone. Numbers are from the fictional 555-01xx range.

import { landscape, skyline, yard } from './art.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;

const SVG = 'image/svg+xml';

export const smarthome = () => {
  const light = (id, name, area, brightness, rgb) => ({ id: `light.${id}`, name, area, domain: 'light', state: brightness ? 'on' : 'off', brightness, rgb });
  const sensor = (id, name, area, state, unit, deviceClass) => ({ id: `sensor.${id}`, name, area, domain: 'sensor', state, unit, deviceClass });
  const feed = {
    configured: true, connected: true, areaOrder: ['Living room', 'Kitchen', 'Bedroom'], tileView: 'compact',
    entities: [
      light('ceiling', 'Ceiling light', 'Living room', 184, [255, 197, 122]),
      light('floor_lamp', 'Floor lamp', 'Living room', 128, [124, 92, 255]),
      { id: 'climate.living', name: 'Thermostat', area: 'Living room', domain: 'climate', state: 'heat', current: 21.4, target: 22 },
      sensor('living_air', 'Air quality', 'Living room', '412', 'ppm', 'carbon_dioxide'),
      light('desk', 'Desk lamp', 'Living room', 200, [110, 231, 135]),
      { id: 'cover.blinds', name: 'Blinds', area: 'Living room', domain: 'cover', state: 'open' },
      sensor('desk_power', 'Desk plug', 'Living room', '142', 'W', 'power'),
      sensor('living_hum', 'Humidity', 'Living room', '46', '%', 'humidity'),
      light('counter', 'Counter lights', 'Kitchen', 230, [255, 214, 160]),
      { id: 'switch.coffee', name: 'Coffee machine', area: 'Kitchen', domain: 'switch', state: 'on' },
      sensor('fridge', 'Fridge', 'Kitchen', '4.1', '°C', 'temperature'),
      sensor('kitchen_power', 'Oven plug', 'Kitchen', '86', 'W', 'power'),
      light('bedside', 'Bedside lamp', 'Bedroom', 0),
      { id: 'switch.purifier', name: 'Air purifier', area: 'Bedroom', domain: 'switch', state: 'off' },
      sensor('bedroom_temp', 'Temperature', 'Bedroom', '19.8', '°C', 'temperature'),
      sensor('bedroom_hum', 'Humidity', 'Bedroom', '52', '%', 'humidity'),
    ],
  };
  return { answers: { '/api/homeassistant/state': feed }, events: { homeassistant: feed } };
};

export const unifi = () => {
  const views = [
    ['front', 'Front door', { seed: 3, zoom: 1.7 }],
    ['drive', 'Driveway', { seed: 8, mirror: true }],
    ['yard', 'Back yard', { seed: 14, zoom: 1.25, mirror: true }],
    ['gate', 'Side gate', { seed: 21, night: true }],
  ];
  return {
    settings: { unifi: { columns: 2 } },
    answers: { '/api/unifiprotect/state': { configured: true, cameras: views.map(([id, name]) => ({ id, name, connected: true })) } },
    files: Object.fromEntries(views.map(([id, , view]) => [`/api/unifiprotect/snapshot/${id}`, { type: SVG, body: yard(view) }])),
  };
};

export const transfer = (now) => {
  const item = (id, name, size, ago, direction, more = {}) => ({ id, name, size, at: now - ago, ext: name.split('.').pop(), direction, ...more });
  const items = [
    item('t1', 'harbor-sunset.jpg', 4.2 * MB, 3 * MIN, 'in', { thumb: true, from: 'Phone' }),
    item('t2', 'old-town-night.jpg', 3.1 * MB, 9 * MIN, 'in', { thumb: true, from: 'Phone' }),
    item('t3', 'trip-notes.pdf', 1.4 * MB, 2 * HOUR, 'out'),
    item('t5', 'ridge-walk.jpg', 5.6 * MB, DAY, 'in', { thumb: true, from: 'Tablet' }),
  ];
  const feed = { ok: true, enabled: true, items, pending: [{ id: 'p1', name: 'cabin-tour.mp4', total: 640 * MB, received: 410 * MB }], bytes: 824 * MB, quotaBytes: 8192 * MB, maxBytes: 2048 * MB };
  const thumbs = { t1: landscape({ seed: 4, w: 160, h: 160 }), t2: skyline({ seed: 12, w: 160, h: 160 }), t5: landscape({ seed: 17, top: '#183a4a', bottom: '#7bd0c1', sun: '#fff1b8', hills: ['#2c6e6a', '#1e4f54', '#123238'], w: 160, h: 160 }) };
  return {
    answers: { '/api/transfer/list': feed },
    events: { transfer: feed },
    files: Object.fromEntries(Object.entries(thumbs).map(([id, body]) => [`/api/transfer/thumb?id=${id}`, { type: SVG, body }])),
  };
};

export const phone = (now) => {
  const call = (name, number, direction, ago) => ({ name, number, direction, at: now - ago });
  return {
    answers: {
      '/api/phone': { ok: true, device: 'My phone', pbap: true, telephony: true, canDial: true, state: {} },
      '/api/phone/calls': {
        ok: true,
        list: [
          call('Nina Vale', '+1 202 555 0143', 'missed', 12 * MIN),
          call('Theo Marsh', '+1 202 555 0177', 'in', 2 * HOUR),
          call('Parts delivery', '+1 202 555 0119', 'in', 5 * HOUR),
          call('Rin Sato', '+1 202 555 0164', 'out', 9 * HOUR),
          call('Nina Vale', '+1 202 555 0143', 'out', DAY),
          call('Jonas Lind', '+1 202 555 0108', 'in', 2 * DAY),
        ],
      },
      '/api/phone/contacts': { ok: true, list: [] },
    },
  };
};
