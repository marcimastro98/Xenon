'use strict';

// Which Ambient scene to show, shared by the dashboard (js/ambient-mode.js) and
// the desktop scene page (scene.html, js/screen-scene.js), so the wallpaper and
// the screensaver always show the scene the dashboard would.

const THEME_SCENE_PREFIX = 'theme:';

// The saved themes that carry an animated background of their own.
function themesWithBackground(themes) {
  return (Array.isArray(themes) ? themes : []).filter((t) => {
    const bg = t && t.id && t.bgCustom;
    return !!(bg && bg.enabled === true && typeof bg.code === 'string' && bg.code.trim());
  });
}

// Pick the scene to show for the current settings + installed packages + saved
// canvas scenes. Returns one of:
//   { builtin:true, fallback? }         — the native lockscreen scene
//   { builtin:false, pkg }              — an installed SDK surface:'ambient' pkg
//   { builtin:false, canvas:true, scene } — a native canvas scene (JSON layout)
//   { builtin:false, theme }            — the animated background of a saved theme
// Falls back to builtin when the configured scene is missing, isn't an ambient
// scene, or the SDK subsystem is off — the user must never hit a dead button
// because a package/scene was deleted.
function resolveAmbientScene(cfg, packages, sdkEnabled, scenes, themes) {
  const sceneId = (cfg && typeof cfg.sceneId === 'string') ? cfg.sceneId : 'builtin';
  if (sceneId === 'builtin') return { builtin: true };
  // A saved theme's background ("theme:<id>"): only the desktop scene page passes
  // `themes`, so the dashboard's own idle screen shows the built-in scene for it.
  if (sceneId.indexOf(THEME_SCENE_PREFIX) === 0) {
    const theme = themesWithBackground(themes).find(t => THEME_SCENE_PREFIX + t.id === sceneId);
    return theme ? { builtin: false, theme } : { builtin: true, fallback: 'missing' };
  }
  // Native canvas scene ("canvas:<id>") — first-party, no SDK subsystem needed.
  if (typeof sceneId === 'string' && sceneId.indexOf('canvas:') === 0) {
    const id = sceneId.slice('canvas:'.length);
    const scene = (Array.isArray(scenes) ? scenes : []).find(s => s && s.id === id);
    if (!scene) return { builtin: true, fallback: 'missing' };
    return { builtin: false, canvas: true, scene };
  }
  if (!sdkEnabled) return { builtin: true, fallback: 'sdk_off' };
  const pkg = (Array.isArray(packages) ? packages : [])
    .find(p => p && p.id === sceneId && p.surface === 'ambient');
  if (!pkg) return { builtin: true, fallback: 'missing' };
  return { builtin: false, pkg };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { resolveAmbientScene, themesWithBackground, THEME_SCENE_PREFIX };
