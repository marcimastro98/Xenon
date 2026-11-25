'use strict';
// The stage the person's own Bit stands on in its room (bit-companion/room.js): a small pixel
// theatre drawn cell by cell in the Bit's own colours. The wall is the deep ground of its card
// (BitDna.colors), the curtains take the hue of its accent, the trim is brass. Until it hatches
// the egg stands in a classic red theatre. Each piece is an SVG of whole cells that BitCompanion.css
// sizes by the stage's height, so a cell stays square on every screen; nothing here moves.
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const H = 90; // the stage is 90 cells high; BitCompanion.css sizes every piece in these cells
  const EGG = { hue: 150, curtain: 25 };
  const BRASS = 85;

  // Its colours: the card's ground and words, then the theatre's own tones from its palette.
  function colours(bit) {
    const X = window.Xenon;
    const C = X?.bitColor;
    const pal = bit?.hatched && bit.genes ? X?.bitGenome?.palette(bit.genes.palette) : null;
    const tone = pal ? window.BitDna?.colors(bit) : null;
    const [, chroma, hue] = pal && C ? C.toOklch(pal.body) : [0, 0.08, EGG.hue];
    const curtain = pal && C ? C.toOklch(pal.accent)[2] : EGG.curtain;
    const c = Math.min(chroma, 0.12);
    const ok = (l, ch, h) => (C ? C.oklch(l, ch, h) : `oklch(${l} ${ch} ${h})`);
    return {
      wall: tone?.ink || ok(0.2, 0.02, EGG.curtain),
      text: tone?.text || ok(0.95, 0.01, BRASS),
      muted: tone?.muted || ok(0.76, 0.02, BRASS),
      glow: ok(0.27, c * 0.5, hue),
      floor: ok(0.3, c * 0.55, hue),
      seam: ok(0.26, c * 0.5, hue),
      stand: ok(0.42, c * 0.6, hue),
      standLow: ok(0.34, c * 0.55, hue),
      standTop: ok(0.6, 0.05, hue),
      cloth: ok(0.5, 0.15, curtain),
      fold: ok(0.4, 0.13, curtain),
      brass: ok(0.82, 0.13, BRASS),
    };
  }

  function svg(w, h, fit, cls) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', `0 0 ${w} ${h}`);
    s.setAttribute('preserveAspectRatio', fit);
    s.setAttribute('shape-rendering', 'crispEdges');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', cls);
    return s;
  }

  function rect(s, x, y, w, h, fill) {
    const r = document.createElementNS(NS, 'rect');
    for (const [k, v] of [['x', x], ['y', y], ['width', w], ['height', h], ['fill', fill]]) r.setAttribute(k, String(v));
    s.append(r);
  }

  // How wide a curtain is on row y: full at the top, gathered at the tie-back, open again at the floor.
  const TIE = 58;
  const curtainWidth = (y) => (y < TIE ? Math.round(14 - (y / TIE) * 8) : Math.round(6 + ((y - TIE) / (H - TIE)) ** 1.6 * 8));

  // A curtain, 16 cells wide, drawn a column at a time: each column covers the rows the curtain
  // reaches there, in one or two runs, with a fold every five cells.
  function curtain(c, right) {
    const s = svg(16, H, right ? 'xMaxYMid meet' : 'xMinYMid meet', `broom-curtain ${right ? 'is-right' : 'is-left'}`);
    for (let x = 0; x < 16; x++) {
      const fill = x % 5 < 2 ? c.fold : c.cloth;
      const col = right ? 15 - x : x;
      let start = -1;
      for (let y = 0; y <= H; y++) {
        const on = y < H && curtainWidth(y) > x;
        if (on && start < 0) start = y;
        if (!on && start >= 0) { rect(s, col, start, 1, y - start, fill); start = -1; }
      }
    }
    rect(s, right ? 8 : 0, TIE - 1, 8, 2, c.brass);
    return s;
  }

  // The pelmet across the top: a brass rail and a scallop every ten cells.
  function valance(c) {
    const s = svg(400, 8, 'xMidYMin slice', 'broom-valance');
    rect(s, 0, 0, 400, 4, c.fold);
    for (let x = 0; x < 400; x += 10) {
      rect(s, x, 4, 10, 1, c.fold);
      rect(s, x + 1, 5, 8, 1, c.fold);
      rect(s, x + 3, 6, 4, 1, c.fold);
    }
    rect(s, 0, 3, 400, 1, c.brass);
    return s;
  }

  // The boards, with their seams staggered from row to row.
  function floor(c) {
    const s = svg(400, 16, 'xMidYMax slice', 'broom-floor');
    rect(s, 0, 0, 400, 16, c.floor);
    for (let y = 3; y < 16; y += 4) rect(s, 0, y, 400, 1, c.seam);
    for (let y = 0; y < 16; y += 4) for (let x = (y * 7) % 23; x < 400; x += 23) rect(s, x, y, 1, 3, c.seam);
    rect(s, 0, 0, 400, 1, c.standLow);
    return s;
  }

  // The round stand the Bit turns on.
  function stand(c) {
    const s = svg(44, 10, 'xMidYMax meet', 'broom-stand');
    [28, 36, 40, 42, 44, 44, 42, 40, 36, 28].forEach((w, y) => { rect(s, (44 - w) / 2, y, w, 1, y < 5 ? c.stand : c.standLow); });
    rect(s, 8, 4, 28, 1, c.standTop);
    return s;
  }

  // The spotlight, widening in steps from the pelmet to the stand.
  function light(c) {
    const s = svg(60, 70, 'xMidYMin meet', 'broom-light');
    for (let y = 0; y < 70; y += 2) {
      const w = Math.round(14 + (y / 70) * 46);
      rect(s, (60 - w) / 2, y, w, 2, c.glow);
    }
    return s;
  }

  /**
   * The theatre for this Bit (or the egg): its pieces, back to front, and the colours the
   * words on the stage take.
   * @param {object|null} bit the server's view of the Bit (GET /api/bit)
   */
  function draw(bit) {
    const c = colours(bit);
    return { pieces: [light(c), floor(c), stand(c), curtain(c, false), curtain(c, true), valance(c)], colours: c };
  }

  window.BitScenery = { draw, colours };
})();
