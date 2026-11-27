;((root, factory) => {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bitSigns = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  // The small pixel signs the person's own Bit holds up while it has something to tell: a green flag when
  // Claude Code or Codex finished, a yellow "!" board while one asks, a clock before an event, a bell
  // when a timer ended, a full box for a disk. Five by five cells on a stick in its hand (held()), drawn
  // by the engine with the body (bit.js renderFrame `held`), so it moves with Bit: the same on the
  // dashboard (js/bit-companion/signs.js), the desktop Bit (desk-frames.js) and a widget's Bit (the Bit
  // kit, from the SDK `bit` stream's `signal`). Each reads the same mirrored: the desktop Bit turns.

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
  const KINDS = Object.freeze(Object.keys(SIGNS));

  /** The cells of a sign, { x, y, hex } from its top-left; [] for none or an unknown kind. */
  function cells(kind) {
    const rows = Object.hasOwn(SIGNS, kind) ? SIGNS[kind] : null;
    if (!rows) return [];
    const out = [];
    rows.forEach((row, y) => {
      [...row].forEach((ch, x) => { if (INK[ch]) out.push({ x, y, hex: INK[ch] }); });
    });
    return out;
  }

  // In its hand: the sign's top-left on the stage (bit.js: the body ends at x 9, the arm is at 10,6), and
  // a stick from the sign's bottom-left down to the arm.
  const HAND = Object.freeze({ x: 10, y: 0 });

  /** The sign held up, in stage cells { x, y, hex } with its stick; null for none or an unknown kind. */
  function held(kind) {
    const list = cells(kind);
    if (!list.length) return null;
    const out = list.map((c) => ({ x: HAND.x + c.x, y: HAND.y + c.y, hex: c.hex }));
    out.push({ x: HAND.x, y: HAND.y + SIZE, hex: INK.P });
    return out;
  }

  return Object.freeze({ SIZE, KINDS, HAND, cells, held });
});
