;((root, factory) => {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bitSigns = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  // The small pixel signs over the person's own Bit while it has something to tell: a green flag when
  // Claude Code or Codex finished, a yellow "!" board while one asks, a clock before an event, a bell
  // when a timer ended, a full box for a disk. Five by five cells, the same everywhere: the dashboard
  // (js/bit-companion/signs.js), the desktop Bit (desk-frames.js) and a widget's Bit (the Bit kit,
  // from the SDK `bit` stream's `signal`). Each reads the same mirrored: the desktop Bit turns.

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

  return Object.freeze({ SIZE, KINDS, cells });
});
