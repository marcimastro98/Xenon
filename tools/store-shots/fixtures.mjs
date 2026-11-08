// The invented state behind the Store pictures: a menu with three widgets placed
// and a gallery of a week's captures. Nothing here comes from a real PC.

import { landscape, lighthouse, skyIslands, skyline, volcano } from '../tile-previews/art.mjs';

const DAY = 86400000;
const HOUR = 3600000;
const MINUTE = 60000;
const PER_ROW = 5;   // the gallery's row on a 1920 wide screen: a full row for each day
const THUMB = { w: 640, h: 360 };

// Invented game art, one picture per capture in the order of galleryAnswer: Lantern Trail
// is the open air, Neon Drift the city, and no two captures show the same frame.
export const GALLERY_ART = [
  () => landscape({ seed: 3, top: '#1d3b6e', bottom: '#f2a65a', sun: '#ffe2a8', ...THUMB }),
  () => lighthouse(THUMB),
  () => skyline({ seed: 2, ...THUMB }),
  () => landscape({ seed: 8, top: '#7fc4e8', bottom: '#d9f0c9', sun: '#fff6c8', hills: ['#7fb36a', '#3f7a4a', '#22502f'], ...THUMB }),
  () => landscape({ seed: 19, top: '#20304f', bottom: '#78c2c4', sun: '#f5f0c8', ...THUMB }),
  () => skyline({ seed: 5, top: '#071a2b', bottom: '#0f6a78', glow: '#7cf5d6', lit: '#c9fff0', ...THUMB }),
  () => landscape({ seed: 11, top: '#3a1f4d', bottom: '#e0637a', sun: '#ffd0a0', ...THUMB }),
  () => skyline({ seed: 13, top: '#1a0f2e', bottom: '#a13d63', glow: '#ffb35c', lit: '#ffe4a3', ...THUMB }),
  () => volcano(THUMB),
  () => skyline({ seed: 25, top: '#101a2e', bottom: '#5b3fa8', glow: '#ff7ac6', lit: '#ffd1ec', ...THUMB }),
  () => skyIslands(THUMB),
  () => skyline({ seed: 17, top: '#0f1a3a', bottom: '#2f6fa8', glow: '#ffe9a8', lit: '#fff2c4', ...THUMB }),
  () => skyline({ seed: 21, top: '#1f0b2e', bottom: '#d0406c', glow: '#ffd24f', lit: '#ffc2d8', ...THUMB }),
  () => landscape({ seed: 15, top: '#f0a48a', bottom: '#ffe3b0', sun: '#fff4d8', hills: ['#c98a6f', '#8f5a5f', '#4f3355'], ...THUMB }),
  () => landscape({ seed: 23, top: '#0e2a3a', bottom: '#e8b04a', sun: '#ffeec2', ...THUMB }),
  () => landscape({ seed: 29, top: '#2a1a4a', bottom: '#f08a5d', sun: '#ffe6b0', ...THUMB }),
  () => skyline({ seed: 31, top: '#0a1c2e', bottom: '#1f8a8a', glow: '#ffd07a', lit: '#ffeab8', ...THUMB }),
  () => landscape({ seed: 33, top: '#8fd3f4', bottom: '#fbe7c6', sun: '#fffbe0', hills: ['#8fb98a', '#5a8a6a', '#2f5a4a'], ...THUMB }),
  () => skyline({ seed: 35, top: '#1a1030', bottom: '#7a3fa8', glow: '#7ae0ff', lit: '#d1f4ff', ...THUMB }),
  () => landscape({ seed: 37, top: '#14324a', bottom: '#d8708a', sun: '#ffd8c0', ...THUMB }),
];

/** What GET /captures answers, the newest first. */
export function galleryAnswer(now) {
  // From noon, so a day's captures stay on that day whenever the tool runs.
  const noon = new Date(now).setHours(12, 0, 0, 0);
  const item = (i, kind, name, game, ageDays, seconds) => ({
    // Under an hour of drift keeps the order and stops every day reading 12:00, 11:00, 10:00.
    id: `c${i}`, kind, name, game, createdAt: noon - ageDays * DAY - (i % PER_ROW) * HOUR - (((i + 1) * 17) % 53) * MINUTE, seconds, width: 1920, height: 1080, size: 42000000,
  });
  const entries = [
    item(0, 'replay', 'Lantern Trail clip', 'Lantern Trail', 0, 30),
    item(1, 'screenshot', 'Lantern Trail', 'Lantern Trail', 0, 0),
    item(2, 'recording', 'Neon Drift', 'Neon Drift', 0, 214),
    item(3, 'screenshot', 'Desktop', 'Desktop', 0, 0),
    item(4, 'recording', 'Lantern Trail', 'Lantern Trail', 0, 492),
    item(5, 'replay', 'Neon Drift clip', 'Neon Drift', 1, 45),
    item(6, 'recording', 'Lantern Trail', 'Lantern Trail', 1, 618),
    item(7, 'screenshot', 'Neon Drift', 'Neon Drift', 1, 0),
    item(8, 'replay', 'Lantern Trail clip', 'Lantern Trail', 1, 60),
    item(9, 'replay', 'Neon Drift clip', 'Neon Drift', 1, 30),
    item(10, 'screenshot', 'Lantern Trail', 'Lantern Trail', 3, 0),
    item(11, 'recording', 'Neon Drift', 'Neon Drift', 3, 305),
    item(12, 'replay', 'Neon Drift clip', 'Neon Drift', 3, 30),
    item(13, 'screenshot', 'Desktop', 'Desktop', 3, 0),
    item(14, 'replay', 'Lantern Trail clip', 'Lantern Trail', 3, 45),
    item(15, 'recording', 'Lantern Trail', 'Lantern Trail', 4, 731),
    item(16, 'replay', 'Neon Drift clip', 'Neon Drift', 4, 30),
    item(17, 'screenshot', 'Lantern Trail', 'Lantern Trail', 4, 0),
    item(18, 'screenshot', 'Neon Drift', 'Neon Drift', 4, 0),
    item(19, 'replay', 'Lantern Trail clip', 'Lantern Trail', 4, 60),
  ];
  const games = [...new Set(entries.map(e => e.game))]
    .map(label => ({ label, count: entries.filter(e => e.game === label).length }))
    .sort((a, b) => b.count - a.count);
  return { ok: true, entries, more: false, editable: true, usedBytes: 3200000000, games };
}

/** What XenonMenu.compose() reads, on a PC with every capability. */
export function menuState(now) {
  const probes = new Proxy({}, { get: () => true, has: () => true });
  const rect = (x, y) => ({ x, y, w: 0.22, h: 0.3 });
  return {
    probes,
    layers: {
      enabled: true,
      widgets: [
        { id: 'lw_wx01', kind: 'tile', widget: 'weather', surface: 'desktop', monitor: 'main', rect: rect(0.7, 0.05) },
        { id: 'lw_md01', kind: 'tile', widget: 'media', surface: 'desktop', monitor: 'main', rect: rect(0.7, 0.4) },
        { id: 'lw_pf01', kind: 'tile', widget: 'perf', surface: 'overlay', monitor: 'main', rect: rect(0.02, 0.05) },
      ],
    },
    monitors: [{ id: 'main', name: 'Main screen', primary: true }],
    tiles: ['weather', 'media', 'perf', 'calendar', 'notes', 'tasks'],
    packages: [], shots: {}, deckKeys: [], scenes: [],
    capture: {}, replay: { on: true, seconds: 60 }, recording: false,
    last: { createdAt: now - 3600000, seconds: 30 }, now,
    keys: { menu: 'alt+shift+x', overlay: 'ctrl+shift+f9', replay: 'ctrl+shift+f10' },
    keyStates: { menu: 'listening', overlay: 'listening', replay: 'listening' },
    deck: [], usageMode: 'both', scene: {}, alertsOn: true, quiet: false, companionOn: true, power: null,
  };
}
