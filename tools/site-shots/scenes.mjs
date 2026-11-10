import { readFileSync } from 'node:fs';

// The home page's dashboard shots: one scene per screen size, each a viewport
// and a dashboard layout. initScript() turns a scene into window.__SHOT__
// ({ settings, answers, events }) for page/before-boot.js and page/after-boot.js. All data is invented: no game
// footage, no real names, nothing from this PC.

// Live data the public demo does not carry: a game running with its frame
// times, a Discord call, a Deck with real keys, synced lyrics for the demo's
// first track. Serialized into the page, so it must stay self-contained.
// `deckShape`: the grid the Deck's keys are laid out on, as many keys as it holds.
export function richData(deckShape) {
  const frames = () => Array.from({ length: 120 }, (_, i) => {
    const wave = 6.9 + Math.sin(i / 7) * 0.5 + Math.sin(i / 2.3) * 0.35 + (i === 84 ? 3.4 : 0) + (i === 41 ? 1.8 : 0);
    return Math.round((wave + Math.random() * 0.5) * 100) / 100;
  });
  const perf = () => ({
    active: true, process: 'Skyharbor.exe',
    fps: 143, avgFps: 141, low1Fps: 112, low01Fps: 96,
    frames: frames(),
  });
  const members = [
    { id: 'u1', name: 'nova', speaking: true, mute: false, deaf: false },
    { id: 'u2', name: 'kite', speaking: false, mute: false, deaf: false },
    { id: 'u3', name: 'ember', speaking: false, mute: true, deaf: false },
    { id: 'me', name: 'you', speaking: false, mute: false, deaf: false },
  ];
  const voice = {
    ok: true, channel: { id: 'c1', name: 'Squad' }, members, selfId: 'me',
    mute: false, deaf: false, mode: 'VOICE_ACTIVITY', inputVolume: 88, outputVolume: 100, features: {},
  };
  const channels = [
    { id: 'c1', name: 'Squad', guild: 'Night Shift', guildId: 'g1' },
    { id: 'c2', name: 'Ranked', guild: 'Night Shift', guildId: 'g1' },
    { id: 'c3', name: 'Chill', guild: 'Night Shift', guildId: 'g1' },
  ];
  const key = (id, title, icon, bg, type, extra) => ({
    id, kind: 'action', title, icon: { type: 'builtin', value: icon }, bg, labelPos: 'bottom',
    triggers: { tap: Object.assign({ type }, extra || {}) },
  });
  const deckKeys = [
    key('k1', 'Save replay', 'record', '#c0392b', 'replay'),
    key('k2', 'Snapshot', 'camera', '#2d6cdf', 'screenshot'),
    key('k3', 'Mute mic', 'micOff', '#3a3a3a', 'micMute', { mode: 'toggle' }),
    key('k4', 'Spotify', 'music', '#1f8040', 'mediaPlayPause'),
    key('k5', 'Overlay', 'gamepad', '#6b4bd8', 'layersToggle'),
    key('k6', 'Mark', 'star', '#d98e04', 'captureMarker'),
    key('k7', 'Discord', 'headset', '#5865f2', 'discordMute'),
    key('k8', 'Lights', 'brightness', '#0f8b8d', 'lightingEffect'),
    key('k9', 'Ask Bit', 'chat', '#1f8040', 'ai'),
    key('k10', 'Record', 'video', '#8e2b2b', 'record'),
    key('k11', 'Volume', 'volUp', '#3a3a3a', 'volume', { mode: 'up' }),
    key('k12', 'Lock PC', 'lock', '#3a3a3a', 'lockPc'),
    key('k13', 'Next track', 'next', '#1f8040', 'mediaNext'),
    key('k14', 'Night mode', 'moon', '#2d3f7c', 'lightingEffect'),
    key('k15', 'Captures', 'folder', '#8a6a1f', 'captureGallery'),
    key('k16', 'Favourites', 'heart', '#a33a6b', 'layersToggle'),
    key('k17', 'Wi-Fi', 'wifi', '#2d6cdf', 'lockPc'),
    key('k18', 'Settings', 'settings', '#3a3a3a', 'lockPc'),
  ];
  const { cols, rows } = Object.assign({ cols: 3, rows: 5 }, deckShape);
  const deck = {
    version: 1, cols, rows, keySize: 'md', autoFit: false, showMedia: false, capStyle: 'lcd',
    keyShape: 'rounded', plate: 'theme', transparency: 0, wellImage: null, mediaStyle: null,
    activeProfile: 'p1', autoSwitch: { enabled: false, revert: 'default', rules: [] },
    profiles: [{ id: 'p1', name: 'Game', cols, rows, root: { pages: [{ keys: deckKeys.slice(0, cols * rows) }] } }],
  };
  const words = ['City lights are humming low', 'Every signal starts to glow', 'Run the line until it breaks',
    'Hold the beat for both our sakes', 'Static rain on window glass', 'Let the slow hours pass',
    'Midnight running through the wire', 'Keep it close and keep it higher'];
  const lines = Array.from({ length: 64 }, (_, i) => ({ t: i * 4000, text: words[i % words.length] }));
  const day = 24 * 3600 * 1000;
  const notes = {
    rev: 1, v: 1, activeId: 'n1',
    notes: [
      { id: 'n1', body: ['Release checklist', '', '- write the release notes', '- test the build on macOS',
        '- answer the design review', '- book the team call'].join('\n'), updatedAt: new Date(Date.now() - 3600 * 1000).toISOString() },
      { id: 'n2', body: 'Ideas', updatedAt: new Date(Date.now() - day).toISOString() },
    ],
  };
  return {
    perf, voice, channels, deck, notes,
    lyrics: { ok: true, state: 'synced', key: 'demo-midnight', title: 'Midnight Protocol', source: 'LRCLIB', lines },
  };
}

// Answers and events shared by every scene: the tiles get their data the same
// way on every screen size.
function feeds(rich) {
  return {
    answers: {
      '/perf': rich.perf(),
      '/stream/discord/status': { ok: true, connected: true, login: 'you' },
      '/stream/discord/voice': rich.voice,
      '/stream/discord/channels': { ok: true, channels: rich.channels },
      '/stream/discord/roster': { ok: true, channels: [] },
      '/deck-config': { configs: { deck: rich.deck }, rev: 2, savedAt: null, instanceRevs: {}, presets: [], keyPresets: [] },
      '/api/lyrics': rich.lyrics,
      '/api/features/lyrics': { ok: true, unlocked: true },
      '/notes/list': rich.notes,
    },
    events: {
      perf: rich.perf,
      discord: { connected: true, login: 'you', voice: rich.voice },
      notes: rich.notes,
    },
  };
}

const hidden = { visible: false, page: 'dashboard' };
const tile = (x, y, w, h) => ({ x, y, w, h, visible: true, page: 'dashboard' });
function layout(widgets, mediaAt) {
  const all = { media: hidden, agenda: hidden, system: hidden, chat: hidden };
  return {
    gridCols: 24,
    widgets: Object.assign({}, all, widgets),
    groups: mediaAt ? { 'media-group': Object.assign({ id: 'media-group', members: ['media', 'chat'], active: 'media', page: 'dashboard', seeded: true }, mediaAt) } : {},
    pages: [{ id: 'dashboard', name: '', nameKey: 'page_dashboard' }],
    // The game's FPS lives in the performance tile: the system tile's own FPS
    // card would read "--" next to it.
    cards: { net: { fps: { order: 1, size: 'normal', visible: false }, bandwidth: { order: 3, size: 'wide', visible: true } } },
  };
}

// The Edge's gaming page. The vertical Edge and the phone draw the same layout:
// the app arranges it for those shapes by itself, as it does for a user.
const GAME = layout({
  media: tile(0, 0, 6, 4), chat: tile(0, 0, 6, 4), weather: tile(0, 4, 6, 4),
  system: tile(6, 0, 5, 8), youtube: tile(11, 0, 5, 4), perf: tile(11, 4, 5, 4),
  discord: tile(16, 0, 4, 4), football: tile(16, 4, 4, 4), deck: tile(20, 0, 4, 8),
}, { x: 0, y: 0, w: 6, h: 4 });

const GAME_FIXTURES = ['weather', 'youtube', 'football'];

// Discord stops at the volumes: the Audio row sits below a four row tile and would
// show as half a row.
const NO_AUDIO_ROW = `document.querySelector('.dc-ctl-audio')?.remove();`;
const GAME_OPEN = `document.querySelector('.yt-v-fill')?.click(); ${NO_AUDIO_ROW}`;

// The vertical Edge: the same tiles without the timer, arranged by hand on the
// vertical grid (24 columns by 48 rows, js/dashboard-portrait.js), because the
// generated arrangement leaves the short tiles half empty at that height.
const at = (x, y, w, h) => ({ x, y, w, h, page: 'dashboard' });
const VERTICAL = Object.assign(layout({
  media: tile(0, 0, 6, 4), chat: tile(0, 0, 6, 4), lyrics: tile(0, 4, 6, 4),
  perf: tile(6, 0, 6, 8), system: tile(12, 0, 6, 8),
  discord: tile(18, 0, 6, 4), deck: tile(18, 4, 6, 4),
}, { x: 0, y: 0, w: 6, h: 4 }), {
  portrait: {
    custom: true,
    items: {
      'media-group': at(0, 0, 24, 7), lyrics: at(0, 7, 24, 8), perf: at(0, 15, 24, 8),
      system: at(0, 23, 12, 16), deck: at(12, 23, 12, 16), discord: at(0, 39, 24, 9),
    },
  },
});

// A phone stacks the tiles in reading order, each as tall as its share of the grid.
const PHONE = layout({
  media: tile(0, 0, 24, 7), chat: tile(0, 0, 24, 7),
  deck: tile(0, 7, 24, 6), system: tile(0, 13, 24, 8),
}, { x: 0, y: 0, w: 24, h: 7 });

// Up to six tiles side by side, each a third of the screen wide: the pictures
// of the Xenon menu's Add list (tools/tile-previews/shoot.mjs).
export function tileLayout(tiles) {
  const widgets = {};
  tiles.forEach((id, i) => { widgets[id] = tile((i % 3) * 8, Math.floor(i / 3) * 4, 8, 4); });
  return layout(widgets);
}

export const SCENES = {
  // `crops`: one more picture per tile, named <scene>-<name>.png, for the
  // page's sections that show a single widget. `fixtures`: the tiles that need the
  // invented data of tools/tile-previews and widgets.mjs to look lived in. `settings`:
  // merged into the demo's seed (a theme, see themes.mjs).
  edge: {
    viewport: { width: 2560, height: 720, scale: 2 }, layout: GAME, fixtures: GAME_FIXTURES, open: GAME_OPEN,
    crops: { perf: 'perf', system: 'system', deck: 'deck', discord: 'discord', media: 'media' },
  },
  'edge-vertical': { viewport: { width: 720, height: 2560, scale: 2 }, layout: VERTICAL, deck: { cols: 3, rows: 6 } },
  monitor: {
    viewport: { width: 1920, height: 1080, scale: 2 }, fixtures: ['weather', 'calendar', 'news', 'stocks'],
    layout: layout({
      media: tile(0, 0, 6, 4), chat: tile(0, 0, 6, 4), weather: tile(0, 4, 6, 4),
      agenda: tile(6, 0, 7, 8), system: tile(13, 0, 6, 8),
      news: tile(19, 0, 5, 4), stocks: tile(19, 4, 5, 4),
    }, { x: 0, y: 0, w: 6, h: 4 }),
    crops: { agenda: 'agenda' },
  },
  tablet: {
    viewport: { width: 1180, height: 820, mobile: true, scale: 2 }, deck: { cols: 4, rows: 3 }, open: NO_AUDIO_ROW,
    layout: layout({
      media: tile(0, 0, 8, 4), chat: tile(0, 0, 8, 4), lyrics: tile(0, 4, 8, 4),
      system: tile(8, 0, 8, 8), deck: tile(16, 0, 8, 4), discord: tile(16, 4, 8, 4),
    }, { x: 0, y: 0, w: 8, h: 4 }),
  },
  phone: { viewport: { width: 390, height: 844, mobile: true, scale: 2 }, layout: PHONE, deck: { cols: 4, rows: 2 } },
};

// The app resets a layout saved under an older schema version, so the seed
// carries the current one, read from the app's own source.
function layoutVersion() {
  const src = readFileSync(new URL('../../server/js/settings.js', import.meta.url), 'utf8');
  const m = /const DASHBOARD_LAYOUT_VERSION = (\d+);/.exec(src);
  if (!m) throw new Error('DASHBOARD_LAYOUT_VERSION not found in server/js/settings.js');
  return Number(m[1]);
}

// The page's window.__SHOT__: the shared feeds built in the page (they hold
// functions, re-run each second) and the scene's layout as plain JSON.
export function initScript(scene) {
  return `window.__SHOT__ = (function () {
  const shot = (${feeds.toString()})((${richData.toString()})(${JSON.stringify(scene.deck || null)}));
  shot.settings = { dashboardLayout: ${JSON.stringify(scene.layout)}, dashboardLayoutVersion: ${layoutVersion()}, ...${JSON.stringify(scene.settings || {})} };
  return shot;
})();`;
}
