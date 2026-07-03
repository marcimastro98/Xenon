'use strict';

// ── Ambient FX idle / visibility auto-pause ─────────────────────────────────
// The aurora + neon grid (backgroundfx.css) animate transform/opacity forever.
// A continuously-animating page keeps the compositor presenting frames, which on
// a hybrid-GPU machine (dashboard rendered on the discrete GPU, Xeneon Edge
// driven by the integrated GPU) means every frame is copied cross-adapter — real,
// constant GPU/CPU cost for a picture nobody is looking at. Nothing needs to keep
// drifting while the user is away, so we pause it (body.ambient-idle →
// animation-play-state: paused) after a spell of no interaction, and whenever the
// tab is hidden. Any pointer/key/touch input, or the tab becoming visible again,
// resumes it instantly. The look is identical while the user is present.
//
// This layers cleanly on top of game-mode / perf-mode / overlay-frozen (all of
// which pause the same animations); the class is independent and idempotent.
(function () {
  const IDLE_MS = 60 * 1000;  // pause after a minute without interaction
  const REARM_THROTTLE_MS = 1000; // don't re-arm the idle timer more than 1×/s

  let idleTimer = null;
  let paused = false;
  let lastRearm = 0;

  function setPaused(next) {
    if (next === paused) return;
    paused = next;
    document.body.classList.toggle('ambient-idle', next);
  }

  function armIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => setPaused(true), IDLE_MS);
  }

  // A real interaction: resume at once, then (throttled) restart the countdown.
  // High-frequency events like pointermove would otherwise churn the timer.
  function wake() {
    setPaused(false);
    const now = Date.now();
    if (now - lastRearm < REARM_THROTTLE_MS) return;
    lastRearm = now;
    armIdle();
  }

  const EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
  for (const ev of EVENTS) window.addEventListener(ev, wake, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      setPaused(true);   // nobody's looking — stop presenting frames now
    } else {
      lastRearm = 0;     // force a fresh re-arm on the next wake
      wake();
    }
  });

  armIdle(); // start the countdown from load
})();
