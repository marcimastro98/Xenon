'use strict';
// The person's own Bit as the Windows popup draws it (vitals-nag.ps1 -Palette and -Rows): the
// engine's own first frame of the popup's mood, cut to the cells it fills, as up to 16 colours
// and rows of letters. Null means the popup keeps its classic Bit: still an egg, the classic Bit
// chosen for the app, a mood with its own picture (the ghost) or a frame that does not fit.

const Model = require('./model.js');
const look = require('../shared/src/bit-look.js');
const wardrobe = require('../shared/src/bit-wardrobe.js');
const bit = require('../shared/src/bit.js');

// The popup's moods and the clip that shows each; the ghost keeps the popup's own drawing.
const CLIPS = Object.freeze({ angry: 'angry', worried: 'worry' });
const LETTERS = 'ABCDEFGHIJKLMNOP';
const MAX_CELLS = 20;
// The popup's ink, the background Bit's look is made readable on.
const POPUP_BG = '#0d1117';

function hex(fill) {
  const s = String(fill || '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s.slice(1);
  const m = s.match(/^rgb\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})\)$/);
  return m ? m.slice(1, 4).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('') : '';
}

// Every solid cell of a frame, painted in order: a later rect covers an earlier one.
function cells(layers) {
  const out = new Map();
  for (const layer of layers) {
    const t = layer.transform || { dx: 0, dy: 0 };
    for (const r of layer.rects) {
      const fill = hex(r.fill);
      if (!fill || (r.o ?? 1) < 0.5) continue; // the floor shadow and soft marks stay off
      for (let y = Math.round(r.y + t.dy); y < Math.round(r.y + t.dy + r.h); y++) {
        for (let x = Math.round(r.x + t.dx); x < Math.round(r.x + t.dx + r.w); x++) out.set(`${x},${y}`, fill);
      }
    }
  }
  return out;
}

/**
 * @param {any} model the Bit's store model (store.peek())
 * @param {string} mood the popup's mood: angry | worried | ghost
 * @returns {{ palette: string, rows: string } | null}
 */
function spriteFor(model, mood) {
  const clip = CLIPS[mood];
  if (!clip || !model?.bit) return null;
  try {
    const view = /** @type {any} */ (Model.view(model, new Date()));
    if (!view.hatched || view.everywhere === false || !view.genes) return null;
    const own = look.lookOf(view.genes, { worn: wardrobe.outfit(view.worn || []), background: POPUP_BG });
    const map = cells(bit.renderFrame(clip, 0, { look: own }).layers);
    if (!map.size) return null;
    const xy = [...map.keys()].map((k) => k.split(',').map(Number));
    const [x0, x1] = [Math.min(...xy.map((p) => p[0])), Math.max(...xy.map((p) => p[0]))];
    const [y0, y1] = [Math.min(...xy.map((p) => p[1])), Math.max(...xy.map((p) => p[1]))];
    if (x1 - x0 >= MAX_CELLS || y1 - y0 >= MAX_CELLS) return null;
    const colours = [...new Set(map.values())];
    if (colours.length > LETTERS.length) return null;
    const rows = [];
    for (let y = y0; y <= y1; y++) {
      let row = '';
      for (let x = x0; x <= x1; x++) row += map.has(`${x},${y}`) ? LETTERS[colours.indexOf(map.get(`${x},${y}`))] : '.';
      rows.push(row);
    }
    return { palette: colours.join(','), rows: rows.join('|') };
  } catch {
    return null;
  }
}

module.exports = { spriteFor, CLIPS };
