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
//            lock; patch.wallpaper may be 'toggle', decided inside the lock

const WALLPAPER_MODES = Object.freeze(['toggle', 'on', 'off']);
const SAVER_MINUTES = Object.freeze(['0', '5', '10', '15', '30', '60']);

function available(host) {
  return !!(host && typeof host.scenes === 'function' && host.scenes());
}

function writer(d) {
  return available(d.host) && d.settings && typeof d.settings.setDesktopScene === 'function';
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

module.exports = { WALLPAPER_MODES, SAVER_MINUTES, available, setWallpaper, setSaver };
