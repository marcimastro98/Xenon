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

  // A custom background *video* is the strongest trigger (blur over a decoding
  // frame every tick). settings.js pauses it off this same class, alongside the
  // game/perf holds, so a closing overlay never restarts it mid-game.
  function apply() {
    try { document.body.classList.toggle('overlay-frozen', frozen.size > 0); } catch { /* ignore */ }
  }

  // The Windows app's token while the PC's screens are off (screens_win32.rs). The
  // server hears it too and stops reading the sensors (screens-off/state.js).
  const SCREENS_OFF = 'screens-off';
  function reportScreens() {
    try {
      fetch('/screens-off', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ off: frozen.has(SCREENS_OFF) }),
      }).catch(() => { /* engine away: it reads nothing either */ });
    } catch { /* no fetch: nothing to tell */ }
  }

  // token: a stable id per overlay ('update', 'settings', …). Idempotent — the Set
  // collapses repeat calls, so an over/under-count can't leak the frozen state.
  window.ambientFreeze = function ambientFreeze(token, on) {
    if (!token) return;
    const was = frozen.has(token);
    if (on) frozen.add(token); else frozen.delete(token);
    apply();
    if (token === SCREENS_OFF && was !== !!on) reportScreens();
  };
  // Who holds the freeze, for the lines that explain a paused animation.
  window.ambientFreeze.tokens = () => [...frozen];
  // Said again on every stream open (data-stream.js), so a restarted engine or app
  // never keeps the reads stopped.
  window.ambientFreeze.reportScreens = reportScreens;
})();
