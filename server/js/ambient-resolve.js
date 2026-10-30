'use strict';

// Which Ambient scene to show, shared by the dashboard (js/ambient-mode.js) and
// the desktop scene page (scene.html, js/screen-scene.js), so the wallpaper and
// the screensaver always show the scene the dashboard would.

// Pick the scene to show for the current settings + installed packages + saved
// canvas scenes. Returns one of:
//   { builtin:true, fallback? }         — the native lockscreen scene
//   { builtin:false, pkg }              — an installed SDK surface:'ambient' pkg
//   { builtin:false, canvas:true, scene } — a native canvas scene (JSON layout)
// Falls back to builtin when the configured scene is missing, isn't an ambient
// scene, or the SDK subsystem is off — the user must never hit a dead button
// because a package/scene was deleted.
function resolveAmbientScene(cfg, packages, sdkEnabled, scenes) {
  const sceneId = (cfg && typeof cfg.sceneId === 'string') ? cfg.sceneId : 'builtin';
  if (sceneId === 'builtin') return { builtin: true };
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

if (typeof module !== 'undefined' && module.exports) module.exports = { resolveAmbientScene };
