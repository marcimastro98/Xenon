'use strict';
// The person's own Bit as the Windows popup draws it (vitals-nag.ps1 -Palette and -Rows): the
// engine's own first frame of the popup's mood, cut to the cells it fills, as up to 16 colours
// and rows of letters. Null means the popup keeps its classic Bit: still an egg, the classic Bit
// chosen for the app, a mood with its own picture (the ghost) or a frame that does not fit.

const Model = require('./model.js');
const look = require('../shared/src/bit-look.js');
const wardrobe = require('../shared/src/bit-wardrobe.js');
const bit = require('../shared/src/bit.js');
const { cells, grid } = require('../shared/src/bit-cells.js');

// The popup's moods and the clip that shows each; the ghost keeps the popup's own drawing.
const CLIPS = Object.freeze({ angry: 'angry', worried: 'worry' });
const MAX_CELLS = 20;
// The popup's ink, the background Bit's look is made readable on.
const POPUP_BG = '#0d1117';

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
    const g = grid([cells(bit.renderFrame(clip, 0, { look: own }).layers)], { max: MAX_CELLS });
    return g ? { palette: g.palette.join(','), rows: g.frames[0].join('|') } : null;
  } catch {
    return null;
  }
}

module.exports = { spriteFor, CLIPS };
