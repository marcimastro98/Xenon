'use strict';

// ── Heavy-background guard ───────────────────────────────────────────────────
// A code-defined background repaints the whole screen up to 60 times a second,
// and its code may come from anyone. The Store review and the AI critique catch
// the known heavy shapes before install; this is the last line on the PC
// itself: the frame times every draw() and, when the background keeps eating
// more than its share of the main thread, steps it down in this order:
//   1. half the frame rate      (cost halves, motion speed stays on the clock)
//   2. a quarter of the pixels   (less to fill and upload each frame)
//   3. a still image             (the last frame stays, the loop stops)
// Each step is taken only after the load stays over budget for WINDOWS windows
// in a row, so one slow frame (a GC pause, a tab switch) never trips it.
//
// createGuard/guardStep are self-contained on purpose: custom-bg.js embeds
// their source into the sandboxed frame (Function#toString), so they must not
// reference anything outside their own parameters.
(function () {
  'use strict';

  const LIMITS = Object.freeze({
    // Paints per measuring window (one second at the default 30 fps).
    size: 30,
    // Main-thread ms per second a background may spend: a fifth of one core.
    budget: 200,
    // Consecutive windows over budget before stepping down.
    windows: 2,
  });
  const LEVEL_FPS = 1;
  const LEVEL_RES = 2;
  const LEVEL_STILL = 3;

  function createGuard(fps, limits) {
    return { buf: new Float64Array(limits.size), n: 0, start: 0, over: 0, level: 0, fps: fps, size: limits.size, budget: limits.budget, windows: limits.windows };
  }

  // Feed one draw() duration in ms and the time it started (ms, any clock).
  // → the new level when the guard steps down (1 fps, 2 resolution, 3 still),
  // -1 otherwise. Level 1 also halves g.fps, which the caller turns into its
  // new paint interval.
  //
  // The load is the median draw times the paints that really happened per
  // second, not the fps asked for: a frame the browser already throttles (a
  // busy machine, a background tab) costs less than its cap says, and a pause
  // inside a window only lowers the load, so it can never trip the guard.
  function guardStep(g, ms, now) {
    if (g.level >= 3) return -1;
    if (g.n === 0) g.start = now;
    g.buf[g.n++] = ms;
    if (g.n < g.size) return -1;
    g.n = 0;
    const sorted = Array.prototype.slice.call(g.buf).sort(function (a, b) { return a - b; });
    const span = now + ms - g.start;
    const load = span > 0 ? sorted[g.size >> 1] * g.size * 1000 / span : 0;
    g.over = load > g.budget ? g.over + 1 : 0;
    if (g.over < g.windows) return -1;
    g.over = 0;
    g.level++;
    if (g.level === 1) g.fps = g.fps / 2;
    return g.level;
  }

  const api = { createGuard, guardStep, LIMITS, LEVEL_FPS, LEVEL_RES, LEVEL_STILL };
  if (typeof window !== 'undefined') window.BgGuard = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
