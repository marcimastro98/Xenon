;((root, factory) => {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bitSigns = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  // What the person's own Bit has to tell, never held up in its hand: the light on its antenna takes the
  // sign's colour, and on the screen of its little computer a picture says what it is (a check when
  // Claude Code or Codex finished, a "!" while one asks, a clock before an event, an hourglass when a
  // timer ended, a full box for a disk). Bit sits at that computer while it has something to tell
  // (moments.js rest() 'tell'); away from it only the antenna says it. Drawn by the engine with the body
  // (bit.js renderFrame `signal`): the same on the dashboard (js/bit-companion/signs.js), the desktop Bit
  // (desk-frames.js) and a widget's Bit (the Bit kit, from the SDK `bit` stream's `signal`).

  // The computer's screen on the stage (bit-clips-move.js deskScreen): three cells wide, four tall.
  const SCREEN = Object.freeze({ x: 11, y: 2, w: 3, h: 4 });
  const INK = Object.freeze({ G: '3fd16b', Y: 'ffd23f', W: 'f2f4f7', B: '4a90e2', O: 'f5b83d', R: 'ff5a4d' });
  const SIGNS = Object.freeze({
    done: { tip: INK.G, screen: ['...', '..G', 'G.G', '.G.'] },
    ask: { tip: INK.Y, screen: ['.Y.', '.Y.', '...', '.Y.'] },
    soon: { tip: INK.B, screen: ['WWW', 'WBW', 'WBB', 'WWW'] },
    bell: { tip: INK.O, screen: ['OOO', '.O.', '.O.', 'OOO'] },
    disk: { tip: INK.R, screen: ['WWW', 'RRR', 'RRR', 'RRR'] },
  });
  const KINDS = Object.freeze(Object.keys(SIGNS));

  /** The screen's picture, { x, y, hex } from its top-left; [] for none or an unknown kind. */
  function cells(kind) {
    const rows = Object.hasOwn(SIGNS, kind) ? SIGNS[kind].screen : null;
    if (!rows) return [];
    const out = [];
    rows.forEach((row, y) => {
      [...row].forEach((ch, x) => { if (INK[ch]) out.push({ x, y, hex: INK[ch] }); });
    });
    return out;
  }

  /** The antenna's colour for a sign ('rrggbb'), '' for none. */
  const tip = (kind) => (Object.hasOwn(SIGNS, kind) ? SIGNS[kind].tip : '');

  /** What bit.js renderFrame draws for a sign: { kind, tip, screen } in stage cells; null for none. */
  function signal(kind) {
    if (!Object.hasOwn(SIGNS, kind)) return null;
    const screen = cells(kind).map((c) => ({ x: SCREEN.x + c.x, y: SCREEN.y + c.y, hex: c.hex }));
    return Object.freeze({ kind, tip: tip(kind), screen });
  }

  return Object.freeze({ SCREEN, KINDS, cells, tip, signal });
});
