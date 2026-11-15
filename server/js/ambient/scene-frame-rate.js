'use strict';

// The desktop scene page (scene.html) runs behind the icons or as the
// screensaver, on screens nobody is touching. Its endless CSS animations (the
// lock screen's aurora, the breathing clock, the weather clouds) drift over
// seconds, yet every frame of them redraws a full-screen window: measured on a
// 2560x1440 + 1920x1080 pair, ~0.7 of a core in the GPU process. Stepped to a
// few frames a second they look the same and cost ~0.1. One-shot animations
// (entrances, a digit flip) keep their full rate: they are short and seen.
(function (root) {
  const FPS = 12;

  // Frames for one iteration of an animation `ms` long; 0 = leave it alone.
  function stepsFor(timing, fps) {
    if (!timing || timing.iterations !== Infinity) return 0;
    const ms = Number(timing.duration);
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    return Math.max(2, Math.round((ms / 1000) * (fps || FPS)));
  }

  function step(anim) {
    const effect = anim && anim.effect;
    if (!effect || typeof effect.getTiming !== 'function') return;
    const timing = effect.getTiming();
    const n = stepsFor(timing, FPS);
    // The keyframes keep their own easing; this only quantises the time.
    if (n && timing.easing !== `steps(${n})`) effect.updateTiming({ easing: `steps(${n})` });
  }

  function attach(doc) {
    if (!doc || typeof doc.getAnimations !== 'function') return;
    doc.getAnimations().forEach(step);
    // Scenes mount, re-render and swap their animations at any time.
    doc.addEventListener('animationstart', (e) => {
      const target = e.target;
      if (!target || typeof target.getAnimations !== 'function') return;
      target.getAnimations({ subtree: true }).forEach(step);
    }, true);
  }

  const api = { FPS, stepsFor, attach };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SceneFrameRate = api;
})(typeof window !== 'undefined' ? window : globalThis);
