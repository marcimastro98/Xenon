;((root, factory) => {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bitCellsWarp = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  // Bit's ways of going and coming on the desktop, made of its own cells (bit-cells.js maps,
  // 'x,y' -> 'rrggbb'), so the shell plays them like any other clip (js/bit-companion/desk.js):
  // it crumbles into its bits that fly off, its bits fly back together, or a beam of light drops
  // and opens into it. Only the colours already in the frame are used, and the same seed gives the
  // same frames. The dashboard draws the same ideas on a canvas (js/bit-companion/warp.js).

  const KINDS = Object.freeze({
    crumble: { n: 10, ms: 70 }, // out: the last frame is empty
    assemble: { n: 10, ms: 70 }, // in: the first frame is empty
    beam: { n: 8, ms: 60 }, // in
  });

  /** A small seeded random (mulberry32), so a test sees the same frames every time. */
  function random(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const points = (map) => [...map].map(([k, c]) => {
    const [x, y] = k.split(',').map(Number);
    return { x, y, c };
  });

  function middle(pts) {
    const xs = pts.map((p) => p.x);
    return (Math.min(...xs) + Math.max(...xs)) / 2;
  }

  /** Out: each cell lets go a little after the top ones, drifts up and away, and is gone by the last frame. */
  function crumble(map, n = KINDS.crumble.n, seed = 1) {
    const rnd = random(seed);
    const pts = points(map);
    if (!pts.length) return Array.from({ length: n }, () => new Map());
    const cx = middle(pts);
    const top = Math.min(...pts.map((p) => p.y));
    const tall = Math.max(1, Math.max(...pts.map((p) => p.y)) - top);
    const bits = pts.map((p) => {
      const delay = Math.floor(((p.y - top) / tall) * n * 0.3 + rnd() * 2);
      const life = 2 + Math.floor(rnd() * Math.max(1, n - 1 - delay - 2));
      return { ...p, vx: (p.x - cx) * 0.18 + (rnd() - 0.5), vy: -(0.4 + rnd() * 0.9), delay, end: Math.min(n - 1, delay + life) };
    });
    return Array.from({ length: n }, (_, k) => {
      const out = new Map();
      for (const b of bits) {
        if (k >= b.end) continue;
        const t = Math.max(0, k - b.delay);
        out.set(`${Math.round(b.x + b.vx * t)},${Math.round(b.y + b.vy * t)}`, b.c);
      }
      return out;
    });
  }

  /** In: the crumble played backwards, its bits flying in to their places. */
  function assemble(map, n = KINDS.assemble.n, seed = 2) {
    return crumble(map, n, seed).reverse();
  }

  /** In: a line of light drops down its middle, then opens sideways into Bit. */
  function beam(map, n = KINDS.beam.n) {
    const pts = points(map);
    if (!pts.length) return Array.from({ length: n }, () => new Map());
    const cx = Math.round(middle(pts));
    const top = Math.min(...pts.map((p) => p.y));
    const bottom = Math.max(...pts.map((p) => p.y));
    const half = Math.max(1, ...pts.map((p) => Math.abs(p.x - cx)));
    const drop = Math.max(1, Math.floor(n / 3));
    const light = pts.filter((p) => p.x === cx).sort((a, b) => a.y - b.y)[0]?.c || pts[0].c;
    return Array.from({ length: n }, (_, k) => {
      const out = new Map();
      if (k < drop) {
        const to = top + Math.round(((k + 1) / drop) * (bottom - top));
        for (let y = top; y <= to; y++) out.set(`${cx},${y}`, light);
        return out;
      }
      const reach = k === n - 1 ? half : ((k - drop + 1) / (n - drop)) * half;
      for (const p of pts) if (Math.abs(p.x - cx) <= reach) out.set(`${p.x},${p.y}`, p.c);
      if (k < n - 1) for (let y = top; y <= bottom; y++) out.set(`${cx},${y}`, light);
      return out;
    });
  }

  const MAKE = { crumble, assemble, beam };

  /** The frames of one way of going or coming, as `{ maps, ms }` for desk.js, or null for an unknown one. */
  function frames(kind, map, seed) {
    const make = MAKE[kind];
    return make ? { maps: make(map, KINDS[kind].n, seed), ms: KINDS[kind].ms } : null;
  }

  return { KINDS, crumble, assemble, beam, frames };
});
