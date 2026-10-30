'use strict';
// "Borderless" hint. A game in exclusive full screen (PresentMon's "Hardware:
// Legacy Flip", fpsmon.js `exclusive`) owns the display: no window can draw over
// it unless something is injected into the game, which Xenon never does. When
// the user has widgets over the game, they would simply not appear, so Xenon
// says why once per game, with the fix (borderless or windowed full screen in
// the game's own display settings). It rides on the system tick: no timer here.

// deps: { fps, overlayShown(), broadcast(payload) }
function createExclusiveHint(deps) {
  const d = deps || {};
  let told = '';

  function exclusiveNow() {
    try {
      const s = d.fps && typeof d.fps.getFrameStats === 'function' ? d.fps.getFrameStats() : null;
      return s && s.exclusive === true ? String(s.process || '') : null;
    } catch { return null; }
  }

  function overlayShown() {
    try { return typeof d.overlayShown === 'function' && d.overlayShown() === true; } catch { return false; }
  }

  // Every system tick. `running` is the game in front ('' = none).
  function onTick(running) {
    const game = typeof running === 'string' ? running : '';
    if (!game) { told = ''; return null; }
    if (told === game) return null;
    const process = exclusiveNow();
    if (process == null || !overlayShown()) return null;
    told = game;
    const payload = { process: process || game };
    try { if (typeof d.broadcast === 'function') d.broadcast(payload); } catch { /* the next game asks again */ }
    return payload;
  }

  return { onTick };
}

module.exports = { createExclusiveHint };
