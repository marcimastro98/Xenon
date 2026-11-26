'use strict';
// The small pixel sign over the person's own Bit while it has something to tell (signals.js): a green
// flag when Claude Code or Codex finished, a yellow "!" board while one asks, a clock before an event,
// a bell when a timer ended, a full box for a disk. Five by five cells, the same on every own Bit of the
// dashboard (an SVG of rects beside each data-own-bit host, never markup from text) and on the desktop
// (desk-frames.js stamps the cells over its head). Each reads the same mirrored: the desktop Bit turns.
(() => {
  const SIZE = 5;
  const INK = Object.freeze({
    G: '3fd16b', P: 'd9dde3', Y: 'ffd23f', K: '1d1f24', W: 'f2f4f7', B: '4a90e2', O: 'f5b83d', R: 'ff5a4d',
  });
  const SIGNS = Object.freeze({
    done: ['PGGG.', 'PGGGG', 'PGGG.', 'P....', 'P....'],
    ask: ['YYYYY', 'YYKYY', 'YYKYY', 'YYYYY', 'YYKYY'],
    soon: ['.WWW.', 'WKBKW', 'WKBBW', 'WKKKW', '.WWW.'],
    bell: ['..O..', '.OOO.', '.OOO.', 'OOOOO', '..O..'],
    disk: ['.R.R.', 'WRRRW', 'WRRRW', 'WRRRW', 'WWWWW'],
  });
  const NS = 'http://www.w3.org/2000/svg';
  // The dashboard's Bits that carry one: the corner and the tile (the clock's chip has no room).
  const HOSTS = '[data-own-bit]:not(.bitc-chip)';

  /** The cells of a sign, { x, y, hex } from its top-left; [] for none. */
  function cells(kind) {
    const rows = SIGNS[kind];
    if (!rows) return [];
    const out = [];
    rows.forEach((row, y) => {
      [...row].forEach((ch, x) => { if (INK[ch]) out.push({ x, y, hex: INK[ch] }); });
    });
    return out;
  }

  /** For desk-frames.js: the sign's cells on the desktop grid, its top-left at (x0, y0); null for none. */
  function at(kind, x0, y0) {
    const list = cells(kind);
    return list.length ? new Map(list.map((c) => [`${x0 + c.x},${y0 + c.y}`, c.hex])) : null;
  }

  function svgOf(kind) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'bit-sign bit-sign-' + kind);
    for (const c of cells(kind)) {
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', String(c.x));
      r.setAttribute('y', String(c.y));
      r.setAttribute('width', '1');
      r.setAttribute('height', '1');
      r.setAttribute('fill', '#' + c.hex);
      svg.append(r);
    }
    return svg;
  }

  const kindNow = () => window.BitSignals?.top()?.kind || '';

  /** Every own Bit of the page shows the sign of the moment, or none. */
  function paint() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    const kind = kindNow();
    for (const host of document.querySelectorAll(HOSTS)) {
      const box = host.parentElement;
      if (!box) continue;
      const had = box.querySelector(':scope > .bit-sign');
      if (had?.classList.contains('bit-sign-' + kind)) continue;
      had?.remove();
      if (kind) box.append(svgOf(kind));
    }
  }

  let queued = 0;
  const later = () => { if (!queued) queued = requestAnimationFrame(() => { queued = 0; paint(); }); };
  addEventListener('xenon-bit-signals', later);
  addEventListener('xenon-bit', later);   // a Bit placed again (companion.js, tile.js)

  window.BitSigns = Object.freeze({ SIZE, KINDS: Object.keys(SIGNS), cells, at, svg: svgOf, paint: later, kind: kindNow });
})();
