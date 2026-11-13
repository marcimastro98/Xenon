// What the screensaver settings may hold: the idle times offered and the shapes of a scene
// reference.

// Ambient / Screensaver mode — mirror of normalizeAmbientMode in js/settings.js.
const AMBIENT_IDLE_MINUTES = new Set([0, 1, 2, 5, 10, 15, 30]);
const AMBIENT_SCENE_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const AMBIENT_CANVAS_REF_RE = /^canvas:[a-z0-9][a-z0-9-]{1,40}$/;
const AMBIENT_THEME_REF_RE = /^theme:[A-Za-z0-9_-]{1,40}$/;

module.exports = {
  AMBIENT_IDLE_MINUTES, AMBIENT_SCENE_ID_RE, AMBIENT_CANVAS_REF_RE, AMBIENT_THEME_REF_RE,
};
