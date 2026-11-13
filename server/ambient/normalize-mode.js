// The screensaver settings as saved: a known idle time and scene, the wallpaper and screensaver
// of each screen, the switches as yes or no.

const {
  AMBIENT_IDLE_MINUTES, AMBIENT_SCENE_ID_RE, AMBIENT_CANVAS_REF_RE, AMBIENT_THEME_REF_RE,
} = require('./settings-values.js');
const ScreenSceneModel = require('../js/screen-scene-model.js');
const { DEFAULT_HUB_SETTINGS } = require('../settings/defaults.js');

function normalizeAmbientMode(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.ambientMode;
  const idle = Number(source.idleMinutes);
  // sceneId is 'builtin', an SDK package id, a "canvas:<id>" reference into
  // ambientScenes or a "theme:<id>" one into customThemes — anything else resets
  // to the default.
  const raw = typeof source.sceneId === 'string' ? source.sceneId : '';
  const isScene = (id) => id === 'builtin' || AMBIENT_SCENE_ID_RE.test(id) || AMBIENT_CANVAS_REF_RE.test(id) || AMBIENT_THEME_REF_RE.test(id);
  const sceneId = isScene(raw) ? raw : defaults.sceneId;
  // The animated wallpaper and the screensaver, per screen (js/screen-scene-model.js). Both off by default.
  const saverMinutes = (v) => ([0, 5, 10, 15, 30, 60].includes(Number(v)) ? Number(v) : 0);
  return {
    enabled: source.enabled !== undefined ? !!source.enabled : defaults.enabled,
    idleMinutes: AMBIENT_IDLE_MINUTES.has(idle) ? idle : defaults.idleMinutes,
    sceneId,
    wallpaper: source.wallpaper === true,
    saverMinutes: saverMinutes(source.saverMinutes),
    screens: ScreenSceneModel.normalizeScreens(source.screens),
    byScreen: ScreenSceneModel.normalizeByScreen(source.byScreen, isScene),
    // Mirror of js/settings.js — dropped here, the toggle would snap back off
    // on the next hydrate.
    openOnStartup: source.openOnStartup === true,
  };
}

module.exports = { normalizeAmbientMode };
