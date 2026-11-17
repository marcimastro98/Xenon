// What the Xenon menu is shown with in tools/menu-shots: a monitor and an Edge, widgets on
// the monitor, two phones paired. Every value is invented; nothing is read from this PC.
// The shape is the one server/xenon-menu.js compose() takes (see _xenonMenuState in
// server.js); server/test/menu-shots.test.mjs checks that it still draws the Screens page.

export const MONITORS = [
  { key: 'M1', name: 'DELL U2723QE', primary: true, width: 2560, height: 1440, x: 0, y: 0 },
  { key: 'M2', name: 'XENEON EDGE', width: 2560, height: 720, x: 0, y: 1440 },
];

export const PHONES = [
  { id: 'dev_a1', name: 'Pixel 8' },
  { id: 'dev_b2', name: 'iPad Air' },
];

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
    now: Date.UTC(2026, 10, 17, 10, 0, 0),
    usageMode: 'both',
    alertsOn: true,
    ...over,
  };
}
