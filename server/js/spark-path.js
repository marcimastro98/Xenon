'use strict';

// ── Smooth chart paths (pure) ────────────────────────────────────────────────
// Both chart surfaces in the dashboard — the stat-card sparklines (js/utils.js)
// and the sensor-history charts (js/guardian-history.js, also used by the Power
// widget) — used to join their samples with straight `L` segments, which reads
// as a hard zig-zag on the spiky series the sensors actually produce (ping, CPU
// load, a GPU that idles then spikes).
//
// This turns the same points into a MONOTONE cubic curve (Fritsch–Carlson), so
// the line is soft without inventing data: the tangent is forced to zero at
// every local extremum, which makes overshoot impossible — a curve can never
// bulge past the samples it passes through. Catmull-Rom, the usual quick answer,
// does overshoot, and here that would draw a CPU load above 100%, a negative
// ping, or a temperature dip that never happened. A chart that lies about a
// peak is worse than a jagged one.
//
// The emitted path is always `M` + (n-1) `C` commands, whatever n is — same
// command COUNT and TYPES as the polyline it replaces. That is what keeps
// `transition: d` on the stat sparkline interpolable: Chromium refuses to
// interpolate two paths whose command lists differ in shape, and a refusal
// there is silent (the path snaps instead of gliding).
//
// UMD like sdk-perf.js/theme-palette.js so the maths is unit-testable under
// Node (test/spark-path.test.mjs).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.SparkPath = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // Points arrive from live sensor data, so a null/NaN sample is normal — drop
  // it here rather than emitting a path with "NaN" in it, which the browser
  // discards WHOLE (the chart would vanish, not degrade).
  function cleanPoints(points) {
    if (!Array.isArray(points)) return [];
    const out = [];
    for (const p of points) {
      if (!p) continue;
      const x = Number(p[0]), y = Number(p[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
    }
    return out;
  }

  // Fritsch–Carlson tangents: the weighted harmonic mean of the neighbouring
  // slopes, zeroed wherever the series turns. Guarantees |t| <= 3*|slope|, the
  // condition a cubic Hermite needs to stay inside its own samples.
  function tangents(pts, dx, slope) {
    const n = pts.length;
    const t = new Array(n);
    t[0] = slope[0];
    t[n - 1] = slope[n - 2];
    for (let i = 1; i < n - 1; i++) {
      // <= 0 also covers a flat neighbour, which is what keeps the divisions
      // below away from zero.
      if (slope[i - 1] * slope[i] <= 0) { t[i] = 0; continue; }
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      t[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
    }
    return t;
  }

  // Per-segment Bézier controls for the monotone curve through `pts`, one
  // [c1x, c1y, c2x, c2y] per gap. Kept separate from the string building so a
  // band can compare — and correct — the two edges before either is written.
  function controlsFor(pts) {
    const n = pts.length;
    const dx = new Array(n - 1), slope = new Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      dx[i] = pts[i + 1][0] - pts[i][0];
      slope[i] = dx[i] === 0 ? 0 : (pts[i + 1][1] - pts[i][1]) / dx[i];
    }
    const t = tangents(pts, dx, slope);
    const out = new Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i] / 3;               // Hermite → Bézier: controls at a third
      out[i] = [pts[i][0] + h, pts[i][1] + t[i] * h,
                pts[i + 1][0] - h, pts[i + 1][1] - t[i + 1] * h];
    }
    return out;
  }

  function forwardD(pts, ctrl, f) {
    let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
    for (let i = 0; i < ctrl.length; i++) {
      const c = ctrl[i];
      d += `C${f(c[0])},${f(c[1])} ${f(c[2])},${f(c[3])} ${f(pts[i + 1][0])},${f(pts[i + 1][1])}`;
    }
    return d;
  }

  // Points ([x, y] pairs, x strictly increasing OR strictly decreasing) → an SVG
  // `d`. `decimals` keeps the string short; charts are drawn in a small viewBox
  // and the extra precision is bytes nobody sees.
  function smoothLineD(points, decimals) {
    const pts = cleanPoints(points);
    const dp = Number.isFinite(decimals) ? decimals : 2;
    const f = (v) => v.toFixed(dp);
    if (!pts.length) return '';
    if (pts.length === 1) return `M${f(pts[0][0])},${f(pts[0][1])}`;
    return forwardD(pts, controlsFor(pts), f);
  }

  return { smoothLineD };
});
