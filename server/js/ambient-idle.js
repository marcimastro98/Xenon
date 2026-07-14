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
//
// The aurora/grid freeze is CSS (body.ambient-idle); the ticker is exempt from
// the idle pause — it's live information on a screen that's watched, not
// touched (#72) — and is skipped in the sweep below too. But the dashboard
// also runs ~20 small persistent decorative loops (blinking clock colon, ✦ logo
// shimmer, live/status dots, the "no media" equaliser + art spin, the Vitals
// heartbeat, Bit's bob, ambient Deck keys) — individually tiny, but each keeps
// the WebView2 GPU compositor presenting a fresh frame every vsync, which is the
// constant idle GPU cost users see for a screen nobody is touching. Those are
// paused here precisely via the Web Animations API — every *infinite* running
// animation — rather than a CSS class list: the loops live on ::before/::after
// pseudos and behind ancestor-state selectors (a class list silently misses
// half), while a blanket `*` pause would strand a toast or now-playing card mid
// entry-animation at opacity 0. Filtering to infinite iterations catches exactly
// the decorative loops and never a finite reveal. Resumed 1:1 on wake.
(function () {
  const IDLE_MS = 60 * 1000;  // pause after a minute without interaction
  const REARM_THROTTLE_MS = 1000; // don't re-arm the idle timer more than 1×/s

  // ── Firefox: freeze the ambient motion up front (GitHub #99) ──────────────
  // The dashboard's supported host is WebView2 (Chromium), where the aurora's
  // big blurred, screen-blended blobs animate cheaply. Firefox (Gecko) instead
  // re-rasterizes that full-viewport blur on EVERY frame of the drift animation,
  // so simply opening 127.0.0.1:3030 in Firefox pins the CPU/GPU (fans spin up,
  // the whole tab crawls) until it's closed — while our idle-pause only kicks in
  // after a minute of no input, and active use keeps re-arming it. So on Gecko we
  // treat the heavy background layers as permanently "reduced motion": frozen,
  // hence rasterized once and composited from cache, not redrawn per frame. The
  // look is a still aurora/grid instead of a slowly drifting one (the exact state
  // prefers-reduced-motion already ships), and Chromium/WebView2 is untouched.
  function isGecko() {
    try {
      const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
      // Real Gecko carries "Gecko/<date>" + "Firefox/"; Chromium/Safari only say
      // "like Gecko" (no slash-date). Feature-detect a Mozilla-only property too,
      // so a spoofed UA still gets the fix.
      const uaFirefox = /firefox\//i.test(ua) && /gecko\/\d/i.test(ua);
      const mozOnly = typeof CSS !== 'undefined' && CSS.supports && CSS.supports('-moz-appearance', 'none');
      return uaFirefox || mozOnly;
    } catch { return false; }
  }
  if (isGecko() && document.body) document.body.classList.add('fx-motion-lite');

  let idleTimer = null;
  let paused = false;
  let lastRearm = 0;
  let frozenAnims = []; // decorative loops paused via WAAPI, to resume on wake

  function isInfinite(a) {
    try { return !!a.effect && a.effect.getComputedTiming().iterations === Infinity; }
    catch { return false; }
  }

  // Pause every infinite decorative loop still running. Called right AFTER the
  // ambient-idle class is set, and a sync reflow is forced first, so the aurora/
  // grid/ticker the CSS just paused already read as 'paused' and are skipped —
  // they stay CSS-owned; we only ever touch (and later resume) the rest. New
  // loops that start mid-idle simply run until the next idle cycle.
  function freezeLoops() {
    if (typeof document.getAnimations !== 'function') return;
    void document.body.offsetHeight; // flush style so CSS-paused layers read paused
    for (const a of document.getAnimations()) {
      if (a.playState === 'running' && isInfinite(a)) {
        // The ticker marquee is live information, not decoration: on the Xeneon
        // Edge nobody touches the screen for minutes at a time, so an idle
        // freeze would stop it forever right where it matters (#72). Its CSS
        // freeze block (Ticker.css) likewise excludes ambient-idle.
        const target = a.effect && a.effect.target;
        if (target && typeof target.closest === 'function' && target.closest('#xe-ticker')) continue;
        try { a.pause(); frozenAnims.push(a); } catch { /* inert animation */ }
      }
    }
  }

  function thawLoops() {
    for (const a of frozenAnims) { try { a.play(); } catch { /* removed/finished */ } }
    frozenAnims = [];
  }

  function setPaused(next) {
    if (next === paused) return;
    paused = next;
    document.body.classList.toggle('ambient-idle', next);
    if (next) freezeLoops();
    else thawLoops();
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
