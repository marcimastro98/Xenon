'use strict';

// The desktop scene page (scene.html): the animated wallpaper and the
// screensaver show the dashboard's own Ambient overlays, cut from index.html
// here so the two never drift apart.
const { sliceTile } = require('./layer-page');

const SCENE_MARK = '<!-- scene markup -->';
const OVERLAYS = Object.freeze(['#lockscreen-overlay', '#ambient-scene-overlay', '#ambient-canvas-overlay']);

// An overlay missing from index.html is left out: its scene then falls back
// (js/screen-scene.js mounts the lock screen when a mount fails).
function compose(html, dashboardHtml) {
  const dash = String(dashboardHtml || '');
  const markup = OVERLAYS.map((ref) => sliceTile(dash, ref)).filter(Boolean).join('\n');
  // A function, so a "$" in the markup is never read as a replacement pattern.
  return String(html).replace(SCENE_MARK, () => markup);
}

module.exports = { compose, SCENE_MARK, OVERLAYS };
