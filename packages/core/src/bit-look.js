;((root, factory) => {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const deps = node
    ? [require('./bit-clips.js'), require('./bit-genes.js'), require('./bit-genome.js'), require('./bit-color.js')]
    : [root.Xenon.bitClips, root.Xenon.bitGenes, root.Xenon.bitGenome, root.Xenon.bitColor];
  const mod = factory(deps[0], deps[1], deps[2], deps[3]);
  if (node) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bitLook = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, (clips, G, genome, color) => {
  'use strict';

  /* Genes (bit-genome.js) plus what the Bit wears, turned into a `look`:
   * ready-made coloured cells that bit.js paints around the fixed body.
   * bit.js stays a plain painter; every decision about colour lives here. */

  const { BODY, CHEEKS, INK } = clips;
  const OUTLINE_BELOW = 3; // contrast with the background under which Bit gets an outline
  const SHINE = '#ffffff';
  const SPARKLE = '#fff6c8';

  function unitCells(list) {
    const out = [];
    for (const [x, y, w = 1, h = 1] of list) {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out.push([x + i, y + j]);
    }
    return out;
  }

  const BODY_SET = new Set(unitCells(BODY).map(([x, y]) => `${x},${y}`));
  const inBody = ([x, y]) => BODY_SET.has(`${x},${y}`);
  // Eyes, brows and mouth live here; only light (cream) markings may sit under them.
  const inFace = ([x, y]) => x >= 3 && x <= 8 && y >= 3 && y <= 8;

  const byId = (list, id) => list.find((v) => v.id === id);
  const cellRects = (cells, fill, o = 1) => cells.map(([x, y]) => ({ x, y, w: 1, h: 1, fill, o }));

  function markings(pattern, roleColor, pal) {
    if (!pattern || pattern.role === 'none') return [];
    const fill = pattern.role === 'cream' ? pal.cream : pal[roleColor] || pal.shadow;
    const cells = unitCells(pattern.cells).filter((c) => inBody(c) && (pattern.role === 'cream' || !inFace(c)));
    return cellRects(cells, fill);
  }

  function eyeColor(id) {
    const e = byId(G.EYES, id);
    return e && e.L != null ? color.oklch(e.L, e.C, e.h) : INK;
  }

  function cheeks(id, pal) {
    const c = byId(G.CHEEKS, id) || G.CHEEKS[0];
    const fill = c.fill === 'shadow' ? pal.shadow : c.fill;
    const opacity = c.cells ? 1 : c.always ? 0.6 : CHEEKS.opacity;
    return { fill, always: c.always, opacity, cells: c.cells || CHEEKS.cells };
  }

  // A shiny Bit: a gloss on the top-left of the head and a twinkle beside it.
  function shine(shiny) {
    if (!shiny) return [];
    return [...cellRects([[3, 2], [4, 2], [2, 3]], SHINE, 0.75), ...cellRects(unitCells([[10, -2], [9, -1, 3], [10, 0]]), SPARKLE)];
  }

  function resolveFill(fill, pal) {
    if (fill === 'ink') return INK;
    return pal[fill] || fill;
  }

  /* Worn items (bit-wardrobe.js), each split by layer: `back` goes behind
   * the body, `face` over the face (glasses), the rest over the body. `box`
   * (cell edges) lets bit.js set an item down in a clip it would not fit. */
  function wornItems(items, pal) {
    return (items || []).map((item) => {
      const out = { id: item.id, behind: [], over: [], face: [] };
      const slotLayer = item.slot === 'back' ? 'behind' : item.slot === 'face' ? 'face' : 'over';
      const cells = [];
      for (const part of item.layers) {
        const unit = unitCells(part.cells);
        cells.push(...unit);
        out[part.layer || slotLayer].push(...cellRects(unit, resolveFill(part.fill, pal), part.o == null ? 1 : part.o));
      }
      const xs = cells.map((c) => c[0]);
      out.box = { x0: Math.min(...xs), x1: Math.max(...xs) + 1, y0: Math.min(...cells.map((c) => c[1])) };
      return out;
    });
  }

  function outlineFor(pal, background) {
    if (!/^#[0-9a-f]{6}$/i.test(background || '')) return null;
    if (color.contrast(pal.body, background) >= OUTLINE_BELOW) return null;
    return color.luminance(background) > 0.4 ? pal.line : pal.cream;
  }

  /**
   * @param {{ palette: string, pattern: string, patternColor: string, tip: string, eyes: string, cheeks: string, shiny: boolean }} g
   *   genes from bitGenome.decode()
   * @param {{worn?: object[], background?: string}} [opts]
   *   worn: item definitions from bitWardrobe; background: '#rrggbb' behind Bit
   */
  function lookOf(g, opts = {}) {
    const pal = genome.palette(g.palette);
    if (!pal) throw new Error(`Unknown Bit palette: ${g.palette}`);
    const tip = byId(G.TIPS, g.tip) || G.TIPS[0];
    return Object.freeze({
      body: pal.body,
      accent: pal.accent,
      marks: [...markings(byId(G.PATTERNS, g.pattern), g.patternColor, pal), ...shine(g.shiny)],
      tip: { stem: cellRects(unitCells(tip.stem), pal.body), light: unitCells(tip.light) },
      eyes: eyeColor(g.eyes),
      cheeks: cheeks(g.cheeks, pal),
      worn: wornItems(opts.worn, pal),
      outline: outlineFor(pal, opts.background),
    });
  }

  return { lookOf, unitCells, inBody, inFace };
});
