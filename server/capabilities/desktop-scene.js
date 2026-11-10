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
const ScreenSceneModel = require('../js/screen-scene-model.js');

const WALLPAPER_MODES = Object.freeze(['toggle', 'on', 'off']);
const SAVER_MINUTES = Object.freeze(['0', '5', '10', '15', '30', '60']);
const BUILTIN = 'builtin';
const SCENE_PARTS = Object.freeze(['clock', 'weather', 'media', 'calendar']);
// What a scene is for: one screen's wallpaper or screensaver, or the Ambient of the
// dashboard's screen. 'none' leaves a screen with the PC's own wallpaper.
const SCENE_FOR = Object.freeze(['wallpaper', 'saver', 'ambient']);
const NO_SCENE = Object.freeze(['none', 'off', 'windows']);
// The delay a screensaver gets when one is picked for a screen while none was on.
const FIRST_SAVER_MINUTES = 10;

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
// `id`: one scene, by default the dashboard's Ambient.
function sceneWaiting(hs, scenes, id = (hs.ambientMode || {}).sceneId) {
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

// The screens as the menu numbers them, and which one has the dashboard.
function whereOf(host) {
  const screens = screensOf({ monitors: typeof host.monitors === 'function' ? host.monitors() : [] });
  const active = typeof host.dashboard === 'function' ? host.dashboard() : '';
  return { screens, displays: screens.map((m) => ({ id: m.key })), active };
}

function findScene(list, want) {
  return list.find((s) => s.id === want) || list.find((s) => s.name && s.name.toLowerCase() === want.toLowerCase());
}

// What to write for one request: one screen, every screen showing a scene, or the
// dashboard's Ambient. A pick on the dashboard's screen is its Ambient; a scene
// named for nothing in particular is the Ambient too, and every screen's scene.
function scenePatch(found, kind, at, where) {
  const own = at && (at.key !== where.active || where.screens.length === 1);
  if (kind === 'ambient' || (at && !own)) return found ? { sceneId: found.id } : null;
  const scene = found ? found.id : '';
  if (at) return { screen: { key: at.key, kind: kind || 'wallpaper', scene }, where };
  const patch = { everywhere: { id: scene, kinds: kind ? [kind] : ScreenSceneModel.ON_SCREEN.slice() }, where };
  if (found && !kind) patch.sceneId = found.id;
  return patch;
}

// Bit says the name, the menu sends the id; only what is in the list is written.
async function setScene(d, action) {
  if (action.show != null && writer(d)) return setParts(d, action);
  if (!writer(d) || typeof d.settings.desktopScenes !== 'function') return { ok: false, error: 'unavailable' };
  const kind = String(action.for == null ? '' : action.for).trim().toLowerCase();
  if (kind && !SCENE_FOR.includes(kind)) return { ok: false, error: 'bad_for', choices: SCENE_FOR.slice() };
  const where = whereOf(d.host);
  const wantScreen = action.screen != null && String(action.screen).trim() !== '';
  const at = wantScreen ? where.screens[Number(action.screen) - 1] : null;
  if (wantScreen && !at) return { ok: false, error: 'bad_screen', choices: where.screens.map((_, i) => String(i + 1)) };
  const { packages, canvases, themes } = await d.settings.desktopScenes();
  const list = sceneList(packages, canvases, themes);
  const want = String(action.scene == null ? '' : action.scene).trim();
  const found = NO_SCENE.includes(want.toLowerCase()) ? null : findScene(list, want);
  if (!found && !NO_SCENE.includes(want.toLowerCase())) return { ok: false, error: 'unknown_scene', choices: list.map((s) => s.name).filter(Boolean) };
  const patch = scenePatch(found, kind, at, where);
  if (!patch) return { ok: false, error: 'needs_scene', choices: list.map((s) => s.name).filter(Boolean) };
  const saved = await d.settings.setDesktopScene(patch);
  return saved ? { ok: true, scene: found ? found.name : 'none' } : { ok: false, error: 'failed' };
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

// Writes `kind` on every screen: `value(row)` gives the new scene, or null to keep.
// `master` (a pick on one screen in the menu): the other screens keep what is on
// them now, so a paused wallpaper or a screensaver set to never stays off there, and
// the pick turns it on, or off with none left. Without it (Bit, every screen at once)
// the stored choices change and nothing is turned on.
function pickOnScreens(next, where, kind, value, master) {
  const live = next.enabled !== false && (kind === 'wallpaper' ? next.wallpaper : next.saverMinutes > 0);
  const rows = ScreenSceneModel.plan({ settings: { ambientMode: next }, displays: where.displays, active: where.active, noDashboard: !where.active });
  for (const r of rows) {
    const v = value(r);
    const keep = !master || live ? r[kind] : '';
    next.byScreen[r.key] = { wallpaper: '', saver: '', ...next.byScreen[r.key], [kind]: v == null ? keep : v };
  }
  if (!master) return;
  const any = Object.values(next.byScreen).some((e) => e[kind]);
  if (any) next.enabled = true;
  if (kind === 'wallpaper') next.wallpaper = any;
  else next.saverMinutes = any ? (next.saverMinutes || FIRST_SAVER_MINUTES) : 0;
}

// The next ambientMode for a patch from setDesktopScene, `a` normalized. Pure; the
// settings writer runs it under the lock (server.js updateDesktopSceneSetting).
function applyPatch(a, patch) {
  const next = { ...a, byScreen: JSON.parse(JSON.stringify(a.byScreen || {})) };
  if (patch.wallpaper === 'toggle') next.wallpaper = !next.wallpaper;
  else if (patch.wallpaper === 'on' || patch.wallpaper === 'off') next.wallpaper = patch.wallpaper === 'on';
  if (patch.saverMinutes != null) next.saverMinutes = patch.saverMinutes;
  if (patch.sceneId) next.sceneId = patch.sceneId;
  // Chosen screens go back to one scene for all of them.
  if (patch.screens) { next.screens = patch.screens; next.byScreen = {}; }
  const one = patch.screen;
  if (one) pickOnScreens(next, patch.where, one.kind, (r) => (r.key === one.key ? one.scene : null), true);
  const all = patch.everywhere;
  if (all) for (const kind of all.kinds) everywhere(next, patch.where, kind, all.id);
  return next;
}

// One scene on every screen that shows one of `kind`; no scene turns `kind` off.
function everywhere(next, where, kind, id) {
  if (id || ScreenSceneModel.perScreen(next, kind)) pickOnScreens(next, where, kind, (r) => (r[kind] ? id : null), false);
  if (id) return;
  if (kind === 'wallpaper') next.wallpaper = false;
  else next.saverMinutes = 0;
}

// Every scene in use that waits: the dashboard's Ambient and each screen's own.
function scenesWaiting(hs, scenes) {
  const a = hs.ambientMode || {};
  const ids = new Set([a.sceneId, ...Object.values(a.byScreen || {}).flatMap((e) => [e.wallpaper, e.saver])]);
  return [...ids].filter((id) => id && sceneWaiting(hs, scenes, id));
}

module.exports = { WALLPAPER_MODES, SAVER_MINUTES, BUILTIN, SCENE_PARTS, SCENE_FOR, available, sceneList, sceneWaiting, scenesWaiting, applyPatch, setWallpaper, setSaver, setScene, setScreens };
