// What the Xenon menu is shown with in tools/menu-shots: a monitor and an Edge, widgets on
// the monitor, two phones paired. Every value is invented; nothing is read from this PC.
// The shape is the one server/menu/xenon-menu.js compose() takes (see _xenonMenuState in
// server.js); server/test/menu-shots.test.mjs checks that it still draws the Screens page.

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
    ...over,
  };
}
