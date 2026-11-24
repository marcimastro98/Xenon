// What the Xenon menu is shown with in tools/menu-shots: a monitor and an Edge, widgets on
// the monitor, two phones paired, a round pump screen. Every value is invented; nothing is
// read from this PC.
// The shape is the one server/menu/xenon-menu.js compose() takes (see _xenonMenuState in
// server.js); server/test/menu-shots.test.mjs checks that it still draws the Screens page.

import { createRequire } from 'node:module';

const PumpModel = createRequire(import.meta.url)('../../server/js/pump/pump-model.js');
const PumpFaces = createRequire(import.meta.url)('../../server/js/pump/pump-faces.js');

export const MONITORS = [
  { key: 'M1', name: 'DELL U2723QE', primary: true, width: 2560, height: 1440, x: 0, y: 0 },
  { key: 'M2', name: 'XENEON EDGE', width: 2560, height: 720, x: 0, y: 1440 },
];

const NOW = Date.UTC(2026, 10, 17, 10, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

export const PHONES = [
  { id: 'dev_a1', name: 'Pixel 8', createdAt: NOW - 40 * DAY, lastSeenAt: NOW - DAY },
  { id: 'dev_b2', name: 'iPad Air', createdAt: NOW - 20 * DAY, lastSeenAt: NOW - 2 * DAY },
];

// A busier desk (MENU_DESK=three): a 4K monitor, a portrait one on its left, the Edge under
// it, and one phone paired twice: the first pairing was last seen when the second was made.
export const DESKS = {
  two: { monitors: MONITORS, phones: PHONES },
  three: {
    monitors: [
      { key: 'M1', name: 'LG 27UP850', primary: true, width: 3840, height: 2160, x: 0, y: 0 },
      { key: 'M2', name: 'DELL P2422H', width: 1080, height: 1920, x: -1080, y: 128 },
      { key: 'M3', name: 'XENEON EDGE', width: 2560, height: 720, x: 573, y: 2160 },
    ],
    phones: [
      { id: 'dev_c3', name: 'iPhone', createdAt: NOW - 110 * DAY, lastSeenAt: NOW - 58 * DAY },
      { id: 'dev_d4', name: 'iPhone', createdAt: NOW - 58 * DAY, lastSeenAt: NOW - 3 * 60 * 60 * 1000 },
    ],
  },
};

// The look of a new install (DEFAULT_HUB_SETTINGS in server.js), as /settings sends it.
export const LOOK = {
  appearance: 'dark', styleMode: 'liquid', accent: '#6ee787', background: '#14181c', text: '#f0f3f1',
  contrastGuard: true, panelAlpha: 0.54, bgDim: 0.48, bgBlur: 0, uiRoundness: 1, glassBlur: 22,
  glassSaturate: 160, panelBorderStrength: 1, tileShadowStrength: 0, uiFont: null,
};

// A round pump screen that already showed Xenon through iCUE, on the first ready-made setup,
// showing its usual face. shoot.mjs gives the same setup to the pump page it serves.
export const PUMP_SCREEN = 'pump';
// Its usual face wears four colours of the person's own, so the shots show their pickers too.
export const PUMP_COLORS = Object.freeze(['#ff2e88', '#ffd166', '#ff3b30', '#120a1f']);
const setupScreen = PumpModel.screenFor({ screens: {}, seen: {} }, PUMP_SCREEN);
// MENU_PUMP_STYLE=gauge draws it as Strumento, the menu and the pump page alike; =widget with a
// Store widget made to be the style (an invented one, not installed: the pump page draws the lines).
const STYLE_WIDGET = Object.freeze({ id: 'neon-dial', name: 'Neon Dial', shapes: ['round', 'square'], style: true });
export const PUMP_STYLE = { gauge: 'gauge', widget: 'widget:' + STYLE_WIDGET.id }[process.env.MENU_PUMP_STYLE] || 'xenon';
// MENU_PUMP_LEDS=own lights its ring in two colours of the person's, up to the reading;
// MENU_PUMP_LEDS=palette runs a comet in the Ocean palette, faster and with a longer tail.
const LEDS_BY_NAME = {
  own: { follow: 'own', move: 'level', colors: ['#00e5ff', '#ff2e88'] },
  palette: { follow: 'own', move: 'comet', colors: ['#00e5ff', '#ff2e88'], palette: 'ocean', speed: 72, size: 0.8 },
};
export const PUMP_LEDS = LEDS_BY_NAME[process.env.MENU_PUMP_LEDS] ? Object.freeze(LEDS_BY_NAME[process.env.MENU_PUMP_LEDS]) : null;
const pumpScreen = {
  ...setupScreen, style: PUMP_STYLE, base: { ...setupScreen.base, colors: [...PUMP_COLORS] }, ...(PUMP_LEDS ? { leds: { ...setupScreen.leds, ...PUMP_LEDS } } : {}),
};
// The ring as the pump's settings tell it now (pump-screen/ring.js), drawn round the pump's card:
// in the person's colours, or the face's own as its page says them.
const leds = pumpScreen.leds;
const RING = leds.follow === 'lights' ? null : {
  follow: leds.follow, all: leds.all, effect: PumpFaces.ringEffect(leds, pumpScreen.base, pumpScreen.style, null), speed: leds.speed, reverse: leds.reverse,
  colours: leds.follow === 'own' ? leds.colors : PUMP_COLORS.slice(0, 3),
};
export const PUMP = {
  ring: RING, icue: true, sound: true, detected: [], url: 'http://127.0.0.1:3030/pump-face',
  ...(PUMP_STYLE.startsWith('widget:') ? { widgets: [STYLE_WIDGET] } : {}),
  screens: [{
    screen: PUMP_SCREEN, ...pumpScreen, set: true,
    seen: { shape: 'round', w: 480, h: 480, via: 'icue' }, now: { show: pumpScreen.base, why: 'base' },
  }],
};

/** The state compose() draws the menu from. `over` replaces top-level keys. */
export function menuState(over = {}) {
  return {
    probes: { layers: true, scene: true, usageMode: true },
    layers: {
      enabled: true,
      widgets: [
        { id: 'lw_wthr01', kind: 'tile', widget: 'weather', surface: 'desktop', monitor: 'M1', rect: { x: 0.72, y: 0.06, w: 0.24, h: 0.3 } },
        { id: 'lw_clck01', kind: 'sdk', pkg: 'com.example.clock', surface: 'desktop', monitor: 'M1', rect: { x: 0.72, y: 0.4, w: 0.2, h: 0.2 } },
      ],
    },
    packages: [{ id: 'com.example.clock', name: 'Clock' }],
    monitors: MONITORS,
    scene: { wallpaper: true, dashboard: 'M2' },
    keys: { menu: 'alt+shift+x' },
    now: NOW,
    usageMode: 'both',
    alertsOn: true,
    pump: PUMP,
    ...over,
  };
}
