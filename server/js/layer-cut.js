'use strict';

// The shape a layer window is cut to on Windows. There the window is shaped by a
// region of rectangles, and inside them it has no alpha: whatever the page leaves
// see-through is drawn black. A rounded tile cut to its box showed black corners
// over the game, so its cut follows the corners in steps instead. Each step stays
// inside the curve, so a corner can lose a sliver of the tile but never shows black.
// macOS and Linux have real alpha and clip nothing (their rects only take clicks).
// Pure, in CSS px: layer-host.js turns the boxes into device pixels.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) root.LayerCut = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const MAX_RECTS = 24;   // what the shell reads per list (layers/spec.rs MAX_RECTS)
  const MAX_STEPS = 11;   // per corner: one tile alone spends the whole budget (2 * 11 + 1)
  const MIN_RADIUS = 2;   // under this a square cut is the same to the eye

  // Whether this window's drawing is cut to its rectangles: the Windows shell only.
  function clipsDrawing(shell, userAgent) {
    return shell === true && /Windows/.test(String(userAgent || ''));
  }

  const radiusOf = (box, radius) => Math.max(0, Math.min(Number(radius) || 0, box.width / 2, box.height / 2));

  // How far in from the side the curve is at `y` px from the box's top (or bottom).
  function insetAt(r, y) {
    const d = r - Math.min(r, Math.max(0, y));
    return r - Math.sqrt(r * r - d * d);
  }

  // The box as horizontal bands: `steps` at the top, the middle, `steps` at the bottom.
  // A band takes the inset of its outer edge, the larger one, rounded up, so it stays
  // inside the curve. Band edges sit at equal angles on the curve, so each step moves
  // in and down by about the same amount instead of one big jump at the top. They are
  // whole pixels so neighbours never leave a gap (give the box in device pixels).
  function roundedCut(box, radius, steps) {
    const r = radiusOf(box, radius);
    const n = Math.max(0, Math.floor(steps) || 0);
    if (r < MIN_RADIUS || n === 0) return [box];
    const edge = (i) => Math.round(r * (1 - Math.cos((i / n) * (Math.PI / 2))));
    const top = [];
    const bottom = [];
    for (let i = 0; i < n; i++) {
      const y = edge(i);
      const h = edge(i + 1) - y;
      if (h <= 0) continue;
      const dx = Math.ceil(insetAt(r, y));
      top.push({ left: box.left + dx, top: box.top + y, width: box.width - 2 * dx, height: h });
      bottom.unshift({ left: box.left + dx, top: box.top + box.height - y - h, width: box.width - 2 * dx, height: h });
    }
    const rr = edge(n);
    const middle = { left: box.left, top: box.top + rr, width: box.width, height: box.height - 2 * rr };
    return [...top, middle, ...bottom].filter((b) => b.width > 0 && b.height > 0);
  }

  // The most steps every rounded box can have with all the rects within `budget`.
  // A square box costs one rect; a rounded one 2 * steps + 1. Zero: all cut square.
  function stepsFor(boxes, budget) {
    const rounded = boxes.filter((b) => radiusOf(b.box, b.radius) >= MIN_RADIUS).length;
    if (!rounded) return 0;
    const room = Math.max(0, Math.min(budget, MAX_RECTS)) - boxes.length;
    return Math.max(0, Math.min(MAX_STEPS, Math.floor(room / (2 * rounded))));
  }

  return Object.freeze({ MAX_RECTS, MAX_STEPS, clipsDrawing, roundedCut, stepsFor, insetAt });
});
