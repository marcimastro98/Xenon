'use strict';
// The Ambient scene on the PC itself (js/screen-scene-model.js): the animated
// wallpaper behind the desktop icons and the screensaver. Both live in
// hubSettings.ambientMode; the dashboard (or the "widgets only" driver) opens
// the windows, so this file only changes the choice.
//
// deps (injected):
//   host     { scenes() } — the native shell reported it can draw them
//            (layers-host.js)
//   settings { setDesktopScene(patch) } — writes ambientMode under the settings
//            lock; patch.wallpaper may be 'toggle', decided inside the lock;
//            { desktopScenes() } gives the installed scenes and the person's own

const { themesWithBackground, THEME_SCENE_PREFIX } = require('../js/ambient-resolve.js');
const { screensOf } = require('../menu-tune.js');

const WALLPAPER_MODES = Object.freeze(['toggle', 'on', 'off']);
const SAVER_MINUTES = Object.freeze(['0', '5', '10', '15', '30', '60']);
const BUILTIN = 'builtin';
const SCENE_PARTS = Object.freeze(['clock', 'weather', 'media', 'calendar']);

function available(host) {
  return !!(host && typeof host.scenes === 'function' && host.scenes());
}

function writer(d) {
  return available(d.host) && d.settings && typeof d.settings.setDesktopScene === 'function';
}

// What the wallpaper and the screensaver can show: the built-in scene, the scenes
// from the Store, the person's own and the animated backgrounds of their saved
// themes, under the id hubSettings.ambientMode keeps.
function sceneList(packages, canvases, themes) {
  const list = [{ id: BUILTIN, name: 'Classic' }];
  for (const p of packages || []) if (p && p.id) list.push({ id: p.id, name: p.name || p.id });
  for (const c of canvases || []) if (c && c.id) list.push({ id: 'canvas:' + c.id, name: c.name || '' });
  for (const t of themesWithBackground(themes)) list.push({ id: THEME_SCENE_PREFIX + t.id, name: t.name || '' });
  return list;
}

// The chosen scene is a package nobody approved yet, or community widgets are off:
// every surface then shows the built-in one (js/ambient-resolve.js).
function sceneWaiting(hs, scenes) {
  const id = (hs.ambientMode || {}).sceneId;
  if (!(scenes || []).some((p) => p.id === id)) return false;
  const sdk = hs.sdkWidgets || {};
  return sdk.enabled !== true || !(sdk.grants && sdk.grants[id]);
}

function answer(saved) {
  return saved ? { ok: true, wallpaper: saved.wallpaper ? 'on' : 'off', saverMinutes: saved.saverMinutes } : { ok: false, error: 'failed' };
}

async function setWallpaper(d, action) {
  const mode = action.mode == null ? 'toggle' : action.mode;
  if (!WALLPAPER_MODES.includes(mode)) return { ok: false, error: 'bad_mode', choices: WALLPAPER_MODES.slice() };
  if (!writer(d)) return { ok: false, error: 'unavailable' };
  return answer(await d.settings.setDesktopScene({ wallpaper: mode }));
}

async function setSaver(d, action) {
  const minutes = String(action.minutes);
  if (!SAVER_MINUTES.includes(minutes)) return { ok: false, error: 'bad_minutes', choices: SAVER_MINUTES.slice() };
  if (!writer(d)) return { ok: false, error: 'unavailable' };
  return answer(await d.settings.setDesktopScene({ saverMinutes: Number(minutes) }));
}

// What the Classic scene shows: `all`, `none` or the parts, comma separated.
function partsFrom(words) {
  if (words === 'all') return SCENE_PARTS.slice();
  const list = words === 'none' ? [] : words.split(',').map((w) => w.trim());
  return list.every((w) => SCENE_PARTS.includes(w)) ? list : null;
}

async function setParts(d, action) {
  const parts = partsFrom(String(action.show).trim().toLowerCase());
  if (!parts) return { ok: false, error: 'bad_parts', choices: ['all', 'none', ...SCENE_PARTS] };
  const lockWidgets = Object.fromEntries(SCENE_PARTS.map((p) => [p, parts.includes(p)]));
  const saved = await d.settings.setDesktopScene({ lockWidgets });
  return saved ? { ok: true, show: parts } : { ok: false, error: 'failed' };
}

// Bit says the name, the menu sends the id; only what is in the list is written.
async function setScene(d, action) {
  if (action.show != null && writer(d)) return setParts(d, action);
  if (!writer(d) || typeof d.settings.desktopScenes !== 'function') return { ok: false, error: 'unavailable' };
  const { packages, canvases, themes } = await d.settings.desktopScenes();
  const list = sceneList(packages, canvases, themes);
  const want = String(action.scene == null ? '' : action.scene).trim();
  const found = list.find((s) => s.id === want) || list.find((s) => s.name && s.name.toLowerCase() === want.toLowerCase());
  if (!found) return { ok: false, error: 'unknown_scene', choices: list.map((s) => s.name).filter(Boolean) };
  const saved = await d.settings.setDesktopScene({ sceneId: found.id });
  return saved ? { ok: true, scene: found.name } : { ok: false, error: 'failed' };
}

// `auto`, `all` or screen numbers, 1 being the main screen, as the menu lists them.
function screenKeys(words, screens) {
  if (words === 'auto') return [];
  if (words === 'all') return screens.map((m) => m.key);
  const picked = words.split(',').map((n) => screens[Number(n) - 1]);
  return picked.every(Boolean) ? [...new Set(picked.map((m) => m.key))] : null;
}

async function setScreens(d, action) {
  if (!writer(d) || typeof d.host.monitors !== 'function') return { ok: false, error: 'unavailable' };
  const screens = screensOf({ monitors: d.host.monitors() });
  const keys = screenKeys(String(action.screens == null ? '' : action.screens).trim().toLowerCase(), screens);
  if (!keys) return { ok: false, error: 'bad_screens', choices: ['auto', 'all', ...screens.map((_, i) => String(i + 1))] };
  const saved = await d.settings.setDesktopScene({ screens: keys });
  if (!saved) return { ok: false, error: 'failed' };
  return { ok: true, screens: keys.length ? keys.map((key) => screens.findIndex((m) => m.key === key) + 1) : 'auto' };
}

module.exports = { WALLPAPER_MODES, SAVER_MINUTES, BUILTIN, SCENE_PARTS, available, sceneList, sceneWaiting, setWallpaper, setSaver, setScene, setScreens };
