// What the Game performance tile shows besides the FPS (hubSettings.perfHud):
// the 1% and 0.1% lows, the frame time, the frame-time graph and the CPU/GPU
// row. Every part is ON unless turned off, so an old or missing setting shows
// the tile as it always was. Shared by the dashboard, the layer pages and the
// server (one normalizer, so both sides store the same shape).
(function (root) {
  'use strict';

  const PERF_HUD_PARTS = Object.freeze(['low1', 'low01', 'frame', 'graph', 'hw']);

  function normalizePerfHud(value) {
    const v = value && typeof value === 'object' ? value : {};
    const out = {};
    for (const k of PERF_HUD_PARTS) out[k] = v[k] !== false;
    return out;
  }

  // A change from the AI or a Deck key: only known parts, only booleans.
  function applyPerfHudChange(current, change) {
    const next = normalizePerfHud(current);
    const c = change && typeof change === 'object' ? change : {};
    for (const k of PERF_HUD_PARTS) if (typeof c[k] === 'boolean') next[k] = c[k];
    return next;
  }

  const api = { PERF_HUD_PARTS, normalizePerfHud, applyPerfHudChange };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PerfHud = api;
})(typeof window !== 'undefined' ? window : globalThis);
