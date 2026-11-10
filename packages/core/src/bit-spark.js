;(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.spark = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* The Scintilla: what Bit lives on, and what Bit's answers are paid with.
   * Drawn like Bit: crisp cells, Bit's ink around the shape (so it reads on a
   * light theme too), Bit's yellows inside, and two little eyes. Three frames:
   * at rest, a twinkle with four glints, a blink. The page animates them with
   * CSS (.xspark-f0..2), so the app can stop them under its own freezes; a
   * still spark is frame 0 alone. An empty balance draws it grey and asleep.
   *
   * Grid 15x15, centre (7,7). The star is a row list [y, x0, x1].
   */

  const INK = '#0d1117';
  const SIZE = 15;
  const C = 7;

  const STAR = Object.freeze([
    [1, 7, 7], [2, 7, 7], [3, 6, 8], [4, 6, 8], [5, 5, 9], [6, 3, 11],
    [7, 1, 13],
    [8, 3, 11], [9, 5, 9], [10, 6, 8], [11, 6, 8], [12, 7, 7], [13, 7, 7],
  ]);

  // Warm white heart to orange tips; grey for an empty balance.
  const COLORS = Object.freeze({
    lit: Object.freeze({ core: '#fff8dc', inner: '#ffe58a', arm: '#ffd75e', tip: '#ffab40', glint: '#ffab40' }),
    dim: Object.freeze({ core: '#e4e0d6', inner: '#c4beb1', arm: '#a7a193', tip: '#8a8476', glint: '#c4beb1' }),
  });

  const EYES = Object.freeze({
    open: [[6, 6], [6, 7], [8, 6], [8, 7]],
    shut: [[6, 7], [8, 7]],
  });
  // Orange like the tips, so the twinkle shows on a light theme too.
  const GLINTS = [[2, 2], [12, 2], [2, 12], [12, 12], [11, 3], [3, 11]];

  const FRAMES = Object.freeze([
    { eyes: 'open', glints: [] },
    { eyes: 'open', glints: GLINTS },
    { eyes: 'shut', glints: [] },
  ]);

  const key = (x, y) => x + ',' + y;

  function role(x, y) {
    const d = Math.abs(x - C) + Math.abs(y - C);
    if (d <= 2) return 'core';
    if (d <= 4) return 'inner';
    return d >= 6 ? 'tip' : 'arm';
  }

  function cells() {
    const out = new Map();
    for (const [y, x0, x1] of STAR) for (let x = x0; x <= x1; x += 1) out.set(key(x, y), role(x, y));
    return out;
  }

  // Bit's ink on every empty cell that touches the star on a side.
  function outline(star) {
    const out = new Set();
    for (const k of star.keys()) {
      const [x, y] = k.split(',').map(Number);
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (!star.has(key(nx, ny))) out.add(key(nx, ny));
      }
    }
    return out;
  }

  const STAR_CELLS = cells();
  const OUTLINE = outline(STAR_CELLS);

  function rect(x, y, fill) {
    return `<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/>`;
  }

  function frameMarkup(frame, palette, asleep) {
    const at = (k, fill) => rect(...k.split(','), fill);
    const ink = [...OUTLINE].map((k) => at(k, INK)).join('');
    const body = [...STAR_CELLS].map(([k, r]) => at(k, palette[r])).join('');
    const eyes = EYES[asleep ? 'shut' : frame.eyes].map(([x, y]) => rect(x, y, INK)).join('');
    const glints = frame.glints.map(([x, y]) => rect(x, y, palette.glint)).join('');
    return ink + body + eyes + glints;
  }

  /**
   * The spark as SVG markup (only the module's own numbers and colours).
   * @param {object} [opts]
   * @param {number} [opts.size]   px width/height; omit to size it with CSS
   * @param {boolean} [opts.still] frame 0 only, no animation hooks
   * @param {boolean} [opts.dim]   grey and asleep: an empty balance
   */
  function svg(opts = {}) {
    const palette = opts.dim ? COLORS.dim : COLORS.lit;
    const size = Number.isFinite(opts.size) ? ` width="${opts.size}" height="${opts.size}"` : '';
    const still = opts.still || opts.dim;
    const frames = still ? [FRAMES[0]] : FRAMES;
    const groups = frames.map((f, i) => `<g class="xspark-f${i}">${frameMarkup(f, palette, opts.dim)}</g>`).join('');
    const cls = still ? 'xspark xspark-still' : 'xspark';
    return `<svg class="${cls}" viewBox="0 0 ${SIZE} ${SIZE}"${size} shape-rendering="crispEdges" aria-hidden="true" focusable="false">${groups}</svg>`;
  }

  return Object.freeze({ svg, FRAMES, COLORS, SIZE, INK });
});
