'use strict';

// ── SDK widget performance accounting (pure logic) ──────────────────────────
// The host injects a tiny probe into every served widget document
// (server/sdk-widgets.js PERF_PROBE_SOURCE); the probe posts a compact report
// over the bridge every ~12s. This module owns everything that can be reasoned
// about without a DOM: report validation, per-package folding, and the
// ok/busy/heavy classification behind the Installed tab's activity chip and the
// one-time "a widget is slowing the dashboard" toast.
//
// Diagnostics, not security: the probe runs inside the widget's own context and
// a hostile widget can forge reports — the caps below bound what a forgery can
// claim, and nothing here grants capabilities. UMD like theme-palette.js so the
// thresholds and folding are unit-testable under Node (test/sdk-perf.test.mjs).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.SdkPerf = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // Report cadence/floors. The probe posts every ~12s; the 5s floor tolerates
  // timer jitter while capping a forged flood at a handful of reports a minute.
  const PERF_MIN_INTERVAL_MS = 5000;

  // Heavy = main-thread time lost in >50ms chunks: ≥400ms of long tasks per
  // ~12s window is ~2s blocked per minute — felt as touch lag on the Edge's
  // low-power CPU. Requires HEAVY_STRIKES consecutive windows (~36s sustained)
  // so a startup parse or a one-off spike never flags a widget.
  const HEAVY_LONGTASK_MS = 400;
  // Corroborating signal only, and only while the tile is on the current page:
  // off-page and service frames are rAF-throttled by the browser, so their low
  // FPS is expected and must never count.
  const LOW_FPS = 20;
  const HEAVY_STRIKES = 3;
  // Busy = noticeable but not sustained-heavy: some long-task time this window.
  const BUSY_LONGTASK_MS = 120;

  const RING_SIZE = 10;

  // Validate + clamp one probe report. Returns the normalized report or null.
  // Every field must be a finite number inside its cap — a forged report can't
  // claim absurd values and a partial/garbled one is dropped whole.
  function validatePerfReport(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi) ? v : null;
    const windowMs = num(raw.windowMs, 1000, 60000);
    if (windowMs == null) return null;
    const longTaskMs = num(raw.longTaskMs, 0, 60000);
    const longTasks = num(raw.longTasks, 0, 1000);
    const fps = num(raw.fps, 0, 240);
    const layoutShifts = num(raw.layoutShifts, 0, 10000);
    if (longTaskMs == null || longTasks == null || fps == null || layoutShifts == null) return null;
    if (longTaskMs > windowMs) return null;   // more blocked time than wall time = forged
    return { windowMs, longTaskMs, longTasks: Math.round(longTasks), fps: Math.round(fps), layoutShifts: Math.round(layoutShifts) };
  }

  function emptyAggregate() {
    return {
      ring: [],            // last RING_SIZE validated reports (newest last)
      ltStrikes: 0,        // consecutive windows over HEAVY_LONGTASK_MS
      fpsStrikes: 0,       // consecutive VISIBLE windows under LOW_FPS
      layoutShifts: 0,     // running total (informational only)
      updatedAt: 0,
      notified: false,     // one toast per package per page load
    };
  }

  // Fold one validated report into a package aggregate. `visible` = a tile of
  // this package sits on the current pager page right now; FPS only counts
  // against a widget the user can actually see.
  function foldPerfReport(agg, report, visible, now) {
    const a = agg || emptyAggregate();
    a.ring.push(report);
    if (a.ring.length > RING_SIZE) a.ring.splice(0, a.ring.length - RING_SIZE);
    a.ltStrikes = report.longTaskMs >= HEAVY_LONGTASK_MS ? a.ltStrikes + 1 : 0;
    a.fpsStrikes = (visible && report.fps > 0 && report.fps < LOW_FPS) ? a.fpsStrikes + 1 : 0;
    a.layoutShifts += report.layoutShifts;
    a.updatedAt = now;
    return a;
  }

  // 'heavy'  → sustained long-task pressure or sustained low visible FPS
  // 'busy'   → some long-task time in the latest window, below heavy
  // 'ok'     → quiet
  function classifyPerf(agg) {
    if (!agg || !agg.ring.length) return 'ok';
    if (agg.ltStrikes >= HEAVY_STRIKES || agg.fpsStrikes >= HEAVY_STRIKES) return 'heavy';
    const last = agg.ring[agg.ring.length - 1];
    if (last.longTaskMs >= BUSY_LONGTASK_MS) return 'busy';
    return 'ok';
  }

  // Average long-task ms per minute over the ring — the number shown to users.
  function longTaskMsPerMin(agg) {
    if (!agg || !agg.ring.length) return 0;
    let lt = 0, win = 0;
    for (const r of agg.ring) { lt += r.longTaskMs; win += r.windowMs; }
    return win > 0 ? Math.round((lt / win) * 60000) : 0;
  }

  // Bounded unique list of package ids for sdkWidgets.suspended. The id regex
  // is passed in so the single source of truth stays the caller's constant.
  function normalizeSuspended(list, idRe) {
    if (!Array.isArray(list)) return [];
    const re = idRe instanceof RegExp ? idRe : /^[a-z0-9][a-z0-9-]{1,40}$/;
    const out = [];
    for (const v of list) {
      const id = typeof v === 'string' ? v : '';
      if (re.test(id) && !out.includes(id)) out.push(id);
      if (out.length >= 32) break;
    }
    return out;
  }

  return {
    PERF_MIN_INTERVAL_MS,
    HEAVY_LONGTASK_MS,
    BUSY_LONGTASK_MS,
    LOW_FPS,
    HEAVY_STRIKES,
    validatePerfReport,
    emptyAggregate,
    foldPerfReport,
    classifyPerf,
    longTaskMsPerMin,
    normalizeSuspended,
  };
});
