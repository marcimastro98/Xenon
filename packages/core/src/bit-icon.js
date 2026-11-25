;((root, factory) => {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const bit = node ? require('./bit.js') : root.Xenon.bit;
  const player = node ? require('./bit-player.js') : root.Xenon.bitPlayer;
  const mod = factory(bit, player);
  if (node) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bitIcon = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, (bit, player) => {
  'use strict';

  /* Bit as a small still picture: an icon cropped to what the pose draws, or a
   * one-colour glyph with the face cut out. Pure, like bit.js: the app, the
   * export tool and the tests draw the same markup. Only the engine's numbers
   * and colours go in, never user text. */

  const ICON_PAD = 0.5;

  // The still pose without its floor shadow (it would pull the crop below
  // Bit's body), and the square around what it draws. The square sits on whole
  // cells: a 24 px icon then has its edges on device pixels at 100%, 150%, 200%.
  function pose(clipId, opts = {}) {
    const base = bit.clip(clipId);
    if (!base) return null;
    const index = player.stillIndex(base);
    const clip = { ...base, frames: base.frames.map((f) => ({ ...f, noShadow: true })) };
    const { layers } = bit.renderFrame(clip, index, opts);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const layer of layers) {
      for (const r of layer.rects) {
        x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
        x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
      }
    }
    const side = Math.ceil(Math.max(x1 - x0, y1 - y0) + ICON_PAD * 2);
    const box = [Math.floor((x0 + x1 - side) / 2), Math.floor((y0 + y1 - side) / 2), side, side].join(' ');
    return { clip, index, layers, box };
  }

  /**
   * Bit as an icon: the still pose cropped to a square around it, sized by CSS.
   * @param {{tint?: string, look?: object}} [opts]
   * @returns {string} SVG markup, or '' for an unknown clip
   */
  function icon(clipId, opts = {}) {
    const p = pose(clipId, opts);
    if (!p) return '';
    return bit.frameSvg(p.clip, p.index, { ...opts, size: 24, clipId: 'bitfloor-still' })
      .replace(/ viewBox="[^"]*" width="[^"]*" height="[^"]*"/, ` viewBox="${p.box}"`);
  }

  /**
   * Bit as one colour (currentColor) with its face cut out: the classic ink, or
   * a personal look's own eye colour. No mask or id, so a cloned copy draws the same.
   * @returns {string} SVG markup, or '' for an unknown clip
   */
  function glyph(clipId, opts = {}) {
    const p = pose(clipId, opts);
    if (!p) return '';
    const cut = new Set([bit.INK, opts.look?.eyes].filter(Boolean));
    const paths = p.layers.map((layer) => {
      const d = cutOut(layer.rects, cut);
      const tr = bit.transformAttr(layer.transform);
      return d ? `<path${tr ? ` transform="${tr}"` : ''} d="${d}"/>` : '';
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${p.box}" fill="currentColor">${paths}</svg>`;
  }

  // A layer's solid cells minus its face (`cut` fills) as one path, on a
  // half-cell grid (poses move by halves) so overlapping rects never cancel.
  function cutOut(rects, cut) {
    const on = new Set();
    const cells = (r, fn) => {
      for (let y = Math.round(r.y * 2); y < Math.round((r.y + r.h) * 2); y++) {
        for (let x = Math.round(r.x * 2); x < Math.round((r.x + r.w) * 2); x++) fn(x + ',' + y);
      }
    };
    for (const r of rects) if (r.o >= 1 && !cut.has(r.fill)) cells(r, (k) => on.add(k));
    for (const r of rects) if (cut.has(r.fill)) cells(r, (k) => on.delete(k));
    const rows = new Map();
    for (const k of on) {
      const [x, y] = k.split(',').map(Number);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push(x);
    }
    let d = '';
    for (const [y, xs] of [...rows].sort((a, b) => a[0] - b[0])) {
      xs.sort((a, b) => a - b);
      for (let i = 0; i < xs.length;) {
        let j = i;
        while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
        d += `M${xs[i] / 2} ${y / 2}h${(j - i + 1) / 2}v0.5h${-(j - i + 1) / 2}z`;
        i = j + 1;
      }
    }
    return d;
  }

  /**
   * Marks a picture with how it was made (data-bit-*), so a page can draw it
   * again in place when the look changes. Only word characters go in.
   * @param {string} svg markup from icon(), glyph() or bit.frameSvg()
   * @param {{kind: string, clip: string, tint?: string, size?: number}} how
   */
  function mark(svg, how) {
    const attrs = ['kind', 'clip', 'tint', 'size']
      .filter((k) => how[k] != null && how[k] !== '')
      .map((k) => ` data-bit-${k}="${String(how[k]).replace(/[^\w,.-]/g, '')}"`).join('');
    return svg.replace('<svg', '<svg' + attrs);
  }

  return { icon, glyph, mark, cutOut };
});
