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
  // ── Background-video hold registry ────────────────────────────────────────
  // Reasons the custom background <video> must not play ('overlay', 'idle', …),
  // refcounted like the freeze set below. Two independent systems pause the
  // same element — the frosted-overlay freeze here and the idle auto-pause in
  // ambient-idle.js — and each resuming unconditionally would undo the other:
  // closing Settings mid-idle would restart the video (and the OS wake lock
  // that keeps monitors from standby) with nobody at the screen. Playback
  // resumes only when the LAST holder releases.
  const videoHolds = new Set();

  function applyVideoHolds() {
    try {
      const v = document.getElementById('user-bg-video');
      if (!v) return;
      if (videoHolds.size > 0) { v.pause(); return; }
      // Resume through the canonical safe-play helper (settings.js) so play
      // eligibility keeps a single source of truth; it consults
      // ambientVideoHeld() itself, which is false here by construction.
      if (typeof window.ensureBackgroundVideoPlayback === 'function') {
        window.ensureBackgroundVideoPlayback(v);
      } else if (!v.hidden && !document.hidden) {
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
      }
    } catch { /* ignore */ }
  }

  window.ambientVideoHold = function ambientVideoHold(token, on) {
    if (!token) return;
    if (on) videoHolds.add(token); else videoHolds.delete(token);
    applyVideoHolds();
  };
  window.ambientVideoHeld = function ambientVideoHeld() { return videoHolds.size > 0; };

  const frozen = new Set();

  function apply() {
    const on = frozen.size > 0;
    try { document.body.classList.toggle('overlay-frozen', on); } catch { /* ignore */ }
    // A custom background *video* is the strongest trigger (blur over a decoding
    // frame every tick), so hold it too — invisible behind the blur.
    window.ambientVideoHold('overlay', on);
  }

  // token: a stable id per overlay ('update', 'settings', …). Idempotent — the Set
  // collapses repeat calls, so an over/under-count can't leak the frozen state.
  window.ambientFreeze = function ambientFreeze(token, on) {
    if (!token) return;
    if (on) frozen.add(token); else frozen.delete(token);
    apply();
  };
})();
