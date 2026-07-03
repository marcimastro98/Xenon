'use strict';

// ── Ambient freeze registry (frosted-overlay flicker guard, issue #56) ──────────
// Full-viewport frosted overlays (the update dialog, the Settings panel) blur
// everything behind them with a backdrop-filter. Re-sampling that blur every frame
// over the moving aurora / neon-grid — or a decoding background <video> — flickers
// on some GPUs (notably discrete NVIDIA, e.g. an RTX 4070). Freezing the ambient
// while such an overlay is up makes the backdrop static: identical look behind the
// blur, but nothing changes each frame so there is nothing to re-blur.
//
// Frosted overlays can stack — "Controlla aggiornamenti" opens the update dialog on
// top of Settings — so the freeze is reference-counted by token: the ambient stays
// frozen until the LAST frosted overlay closes. A plain boolean would thaw when the
// inner overlay closed and the flicker would come back under the panel still open.
(function () {
  const frozen = new Set();

  function apply() {
    const on = frozen.size > 0;
    try { document.body.classList.toggle('overlay-frozen', on); } catch { /* ignore */ }
    try {
      // A custom background *video* is the strongest trigger (blur over a decoding
      // frame every tick), so pause/resume it too — invisible behind the blur.
      const v = document.getElementById('user-bg-video');
      if (v) {
        if (on) v.pause();
        else { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
      }
    } catch { /* ignore */ }
  }

  // token: a stable id per overlay ('update', 'settings', …). Idempotent — the Set
  // collapses repeat calls, so an over/under-count can't leak the frozen state.
  window.ambientFreeze = function ambientFreeze(token, on) {
    if (!token) return;
    if (on) frozen.add(token); else frozen.delete(token);
    apply();
  };
})();
