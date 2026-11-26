;((root, factory) => {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bitCells = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  // A rendered Bit frame (bit.renderFrame) as the solid cells it fills, and frames as one grid of
  // letters on a palette of up to 16 colours: what the Windows popup (server/bit/sprite.js) and
  // Bit on the desktop (js/bit-companion/desk.js, drawn by the shell) are given. Only numbers and
  // the engine's own colours go in.

  const LETTERS = 'ABCDEFGHIJKLMNOP';
  const FLOOR_Y = 11; // bit.js: what a layer clips at the floor ends here

  /** '#rrggbb' or 'rgb(r, g, b)' as 'rrggbb'; '' for anything else. */
  function hex(fill) {
    const s = String(fill || '').trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(s)) return s.slice(1);
    const m = s.match(/^rgb\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})\)$/);
    return m ? m.slice(1, 4).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('') : '';
  }

  /**
   * Every solid cell of a frame, painted in order: a later rect covers an earlier one. The floor
   * shadow and soft marks (under half opacity) stay off, and so does what the floor clips.
   * @typedef {{ dx: number, dy: number, sx: number, sy: number, px: number, py: number }} Move
   * @typedef {{ x: number, y: number, w: number, h: number, fill: string, o?: number }} Rect
   * @param {Array<{ transform: object|null, clipFloor?: boolean, rects: Rect[] }>} layers as bit.renderFrame gives them
   * @returns {Map<string, string>} 'x,y' -> 'rrggbb'
   */
  function cells(layers) {
    const out = new Map();
    for (const layer of layers) {
      const t = /** @type {Move} */ (layer.transform || { dx: 0, dy: 0, sx: 1, sy: 1, px: 0, py: 0 });
      const X = (v) => t.dx + t.px + t.sx * (v - t.px);
      const Y = (v) => t.dy + t.py + t.sy * (v - t.py);
      for (const r of layer.rects) {
        const fill = hex(r.fill);
        if (!fill || (r.o ?? 1) < 0.5) continue;
        const [xa, xb] = [X(r.x), X(r.x + r.w)].sort((a, b) => a - b);
        const bottom = layer.clipFloor ? Math.min(Y(r.y + r.h), FLOOR_Y) : Y(r.y + r.h);
        for (let y = Math.round(Y(r.y)); y < Math.round(bottom); y++) {
          for (let x = Math.round(xa); x < Math.round(xb); x++) out.set(`${x},${y}`, fill);
        }
      }
    }
    return out;
  }

  /**
   * Frames' cells as one grid: their common box (or the sides given, cutting what falls outside),
   * the colours in order, and each frame as rows of letters, '.' where nothing is.
   * @param {Map<string, string>[]} maps
   * @param {{ max?: number, x0?: number, x1?: number, y0?: number, y1?: number }} [opts] max cells on a side
   * @returns {{ palette: string[], frames: string[][] } | null} null when it does not fit
   */
  function grid(maps, opts = {}) {
    const max = opts.max || 24;
    const xy = maps.flatMap((m) => [...m.keys()].map((k) => k.split(',').map(Number)));
    if (!xy.length) return null;
    const x0 = opts.x0 ?? Math.min(...xy.map((p) => p[0]));
    const x1 = opts.x1 ?? Math.max(...xy.map((p) => p[0]));
    const y1 = opts.y1 ?? Math.max(...xy.map((p) => p[1]));
    const y0 = opts.y0 ?? Math.min(...xy.filter((p) => p[0] >= x0 && p[0] <= x1).map((p) => p[1]), y1);
    if (x1 - x0 >= max || y1 - y0 >= max) return null;
    const palette = [];
    const frames = maps.map((m) => {
      const rows = [];
      for (let y = y0; y <= y1; y++) {
        let row = '';
        for (let x = x0; x <= x1; x++) {
          const c = m.get(`${x},${y}`);
          if (c && !palette.includes(c)) palette.push(c);
          row += c ? LETTERS[palette.indexOf(c)] || '?' : '.';
        }
        rows.push(row);
      }
      return rows;
    });
    return palette.length > LETTERS.length ? null : { palette, frames };
  }

  return { LETTERS, FLOOR_Y, hex, cells, grid };
});
