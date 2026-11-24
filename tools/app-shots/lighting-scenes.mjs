// Settings → Lighting → Devices with "Who drives the lights" on top (server/lights/drivers.js):
// a LINK hub Xenon drives itself, Corsair lights through iCUE, a motherboard nobody drives, a
// WLED strip on the network and the pump screen holding its ring. The list comes from the
// server's own model, so the shot follows it. The hub also had a look in iCUE: Import from iCUE.
// The Effects tab: the effect cards by group with the chosen one's Customise, and a device set by
// parts with its map moving (two fans in a comet, a strip breathing). tools/app-shots/scenes.mjs spreads these in.
/* global setLang, openSettings */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { driversOf } = require('../../server/lights/drivers.js');

const HUB = { id: 'pretend-hub', model: 'iCUE LINK System Hub', source: 'native', maker: 'Corsair', type: 'fanLedController', ledCount: 0, segments: [] };
const KEYBOARD = { id: 'pretend-kb', model: 'K70 RGB', source: 'icue', type: 'keyboard', ledCount: 0, segments: [] };
const PROVIDERS = [{ id: 'wled', name: 'WLED', type: 'lan', devices: [{ id: 'w1', name: 'Desk strip', host: '192.0.2.40', optedIn: true }] }];
const PART = { available: true, connected: true, devices: [HUB, KEYBOARD], native: { enabled: false, idleBoards: 1 }, providers: PROVIDERS, pumpRing: { owns: true } };
// iCUE connected would light the board itself: the row for nobody shows with iCUE closed, as on
// the PC the request came from, so the shot keeps the Corsair line from a status with iCUE on.
const DRIVERS = [
  ...driversOf({ ...PART, icueHere: true }).filter((r) => r.id !== 'board'),
  ...driversOf({ ...PART, connected: false, devices: [], providers: [], pumpRing: {} }),
];
const STATUS = {
  ...PART, enabled: true, effects: {}, animation: { style: 'none' }, brightness: 1, lightsOut: false,
  pumpRing: { owns: true, all: false, follow: 'screen', devices: [] }, drivers: DRIVERS,
  icueImport: [{ id: HUB.id, name: HUB.model }],
};

async function lightingDevices({ lang = 'it' } = {}) {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  setLang(lang);
  await pause(300);
  try { localStorage.setItem('xenon.lightingTab.v1', 'devices'); } catch { /* the first tab anyway */ }
  openSettings('lighting');
  await pause(1500);
  // On a phone the end of the list is below the fold: show it with the Import from iCUE row.
  document.querySelector('[data-i18n="lighting_icue_import"]')?.scrollIntoView({ block: 'center' });
  await pause(300);
  return null;
}

const scene = (lang, sizes) => ({ sizes, routes: { '/api/lighting/status': STATUS }, open: lightingDevices, arg: { lang } });

const FANS = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => 100 + i);
const FANS_2 = FANS.map((i) => i + 100);
const STRIP = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => 300 + i);
const comet = { style: 'comet', color: '#ff3b6b', speed: 60 };
const breathe = { style: 'breathe', color: '#4cc9f0', speed: 40 };
const PARTS_DEV = {
  id: 'pretend-fans', model: 'Pretend LINK fans', source: 'icue', maker: 'Corsair', type: 'fanLedController', ledCount: 26, mode: 'custom',
  segments: [{ kind: 'fan', ledIds: FANS, model: 'Fan' }, { kind: 'fan', ledIds: FANS_2, model: 'Fan' }, { kind: 'strip', ledIds: STRIP, model: 'Strip' }],
  modeLeds: Object.fromEntries([...FANS.map((id) => [id, comet]), ...FANS_2.map((id) => [id, comet]), ...STRIP.map((id) => [id, breathe])]),
};
const FX_STATUS = {
  available: true, connected: true, enabled: true, effects: {}, brightness: 1, lightsOut: false, devices: [PARTS_DEV], providers: [],
  native: { enabled: false }, pumpRing: {}, drivers: [], cannot: ['fans'],
  animation: { style: 'aurora', palette: ['#00f5a0', '#00b4ff', '#8b5cf6'], speed: 45, chain: true },
};

async function lightingTab({ lang = 'it', tab = 'effects', scroll = '' } = {}) {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  setLang(lang);
  await pause(300);
  try { localStorage.setItem('xenon.lightingTab.v1', tab); } catch { /* the first tab anyway */ }
  openSettings('lighting');
  await pause(2500);
  if (scroll) document.querySelector(scroll)?.scrollIntoView({ block: 'start' });
  await pause(600);
  return null;
}
const fxScene = (lang, sizes, tab, scroll) => ({ sizes, routes: { '/api/lighting/status': FX_STATUS }, open: lightingTab, arg: { lang, tab, scroll } });

export const lightingScenes = {
  'lighting-who': scene('it', ['desk', 'phone']),
  'lighting-who-de': scene('de', ['phone']),
  'lighting-effects': fxScene('it', ['desk', 'phone'], 'effects'),
  'lighting-effects-tune': fxScene('it', ['desk', 'phone'], 'effects', '.lighting-fxtune'),
  'lighting-effects-de': fxScene('de', ['phone'], 'effects', '.lighting-fxtune'),
  'lighting-effects-ja': fxScene('ja', ['desk'], 'effects'),
  'lighting-parts': fxScene('it', ['desk', 'phone'], 'devices', '.lighting-map'),
};
