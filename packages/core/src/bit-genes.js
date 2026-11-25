;((root, factory) => {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bitGenes = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  /* What a personal Bit can be, as plain data. The body shape is never a gene
   * (brand rule, bit-clips.js): every Bit is recognisably Bit, and what makes
   * one unique is its colours, markings, antenna tip, eyes, cheeks and
   * character. Cells use Bit's 12x12 grid like bit-clips.js.
   *
   * Every variant has a tier: c(ommon), u(ncommon) or r(are). A gene first
   * draws a tier with TIER_ODDS, then a variant inside it, so the odds a
   * birth card shows are exact: tier odds / variants in that tier.
   *
   * NEVER reorder or remove an entry: decoded Bits refer to these ids, and a
   * fingerprint registered on the hub must keep meaning the same look. New
   * variants go at the end of their list, with a decoder version bump. */

  const TIER_ODDS = Object.freeze({ c: 0.8, u: 0.17, r: 0.03 });

  // 16 hues x 4 tones = 64 palettes. Hue in OKLCH degrees.
  const HUES = Object.freeze([
    ['rose', 10], ['red', 28], ['coral', 45], ['orange', 62], ['gold', 80], ['lemon', 100], ['lime', 120], ['green', 142],
    ['mint', 162], ['teal', 185], ['cyan', 210], ['sky', 232], ['blue', 255], ['indigo', 275], ['violet', 300], ['magenta', 330],
  ]);

  // Lightness never under 0.66, so the ink face keeps at least 4.5:1 contrast.
  const TONES = Object.freeze([
    { id: 'pastel', L: 0.89, C: 0.085, tier: 'c' },
    { id: 'vivid', L: 0.78, C: 0.19, tier: 'c' },
    { id: 'deep', L: 0.66, C: 0.16, tier: 'u' },
    { id: 'muted', L: 0.74, C: 0.05, tier: 'u' },
  ]);

  // The logo Bit's green (docs/images/bit.svg): 1 Bit in 512 is born classic.
  const CLASSIC = '#6ee787';
  const CLASSIC_ODDS = 1 / 512;
  const SHINY_ODDS = 1 / 4096;

  /* Markings. `role: 'mark'` paints in the Bit's shadow or accent colour and
   * stays off the face (x 3..8, y 3..8) so eyes and mouth always read;
   * `role: 'cream'` is a light patch that may sit under the face, because ink
   * on cream reads even better. bit-look.js clips every cell to the body. */
  const PATTERNS = Object.freeze([
    { id: 'plain', tier: 'c', role: 'none', cells: [] },
    { id: 'cap', tier: 'c', role: 'mark', cells: [[3, 2, 6]] },
    { id: 'socks', tier: 'c', role: 'mark', cells: [[3, 10, 2], [7, 10, 2]] },
    { id: 'boots', tier: 'c', role: 'mark', cells: [[3, 9, 6], [3, 10, 2], [7, 10, 2]] },
    { id: 'sides', tier: 'c', role: 'mark', cells: [[2, 3, 1, 6], [9, 3, 1, 6]] },
    { id: 'ears', tier: 'c', role: 'mark', cells: [[3, 2], [8, 2], [2, 3], [9, 3]] },
    { id: 'antenna', tier: 'c', role: 'mark', cells: [[6, 0, 1, 2]] },
    { id: 'skirt', tier: 'c', role: 'mark', cells: [[2, 7, 1, 2], [9, 7, 1, 2], [3, 9, 6]] },
    { id: 'belt', tier: 'c', role: 'mark', cells: [[3, 9, 6]] },
    { id: 'topknot', tier: 'c', role: 'mark', cells: [[6, 0, 1, 2], [5, 2, 2]] },
    { id: 'dipped', tier: 'c', role: 'mark', cells: [[2, 6, 1, 3], [9, 6, 1, 3], [3, 9, 6], [3, 10, 2], [7, 10, 2]] },
    { id: 'stripes', tier: 'u', role: 'mark', cells: [[2, 3], [9, 3], [2, 5], [9, 5], [2, 7], [9, 7], [3, 9, 6]] },
    { id: 'half', tier: 'u', role: 'mark', cells: [[3, 2, 3], [2, 3, 1, 6], [3, 9, 3], [3, 10, 2]] },
    { id: 'points', tier: 'u', role: 'mark', cells: [[3, 2], [8, 2], [2, 3], [9, 3], [3, 10, 2], [7, 10, 2], [6, 0, 1, 2]] },
    { id: 'hood', tier: 'u', role: 'mark', cells: [[3, 2, 6], [2, 3, 1, 3], [9, 3, 1, 3], [6, 0, 1, 2]] },
    { id: 'spots', tier: 'u', role: 'mark', cells: [[4, 2], [2, 5], [9, 7], [7, 9], [3, 9], [9, 3]] },
    { id: 'diagonal', tier: 'u', role: 'mark', cells: [[3, 2, 2], [2, 3, 1, 2], [7, 9, 2], [9, 7, 1, 2], [7, 10, 2]] },
    { id: 'oneside', tier: 'u', role: 'mark', cells: [[9, 3, 1, 6], [8, 2], [7, 9, 2], [7, 10, 2]] },
    { id: 'muzzle', tier: 'u', role: 'cream', cells: [[4, 6, 4, 3]] },
    { id: 'mask', tier: 'u', role: 'cream', cells: [[3, 3, 6, 3]] },
    { id: 'bib', tier: 'u', role: 'cream', cells: [[4, 8, 4], [3, 9, 6]] },
    { id: 'face', tier: 'r', role: 'cream', cells: [[3, 3, 6, 6]] },
    { id: 'check', tier: 'r', role: 'mark', cells: [[3, 2], [5, 2], [7, 2], [2, 4], [2, 6], [2, 8], [9, 3], [9, 5], [9, 7], [4, 9], [6, 9], [8, 9]] },
    { id: 'frame', tier: 'r', role: 'mark', cells: [[3, 2, 6], [2, 3, 1, 6], [9, 3, 1, 6], [3, 9, 6]] },
  ]);

  const PATTERN_COLORS = Object.freeze([
    { id: 'shadow', tier: 'c' },
    { id: 'accent', tier: 'c' },
  ]);

  /* Antenna tips, on top of the antenna (6,0)-(6,1). `stem` cells take the
   * body colour; `light` cells glow in the mood colour, so the tip is also
   * how a personal Bit shows its mood. Tips stay in rows -1 and -2: Bit jumps
   * up to 3 cells and the stage ends at y -5, and hats need the room. */
  const TIPS = Object.freeze([
    { id: 'bulb', tier: 'c', stem: [], light: [[6, -1]] },
    { id: 'bead', tier: 'c', stem: [[6, -1]], light: [[6, -2]] },
    { id: 'capsule', tier: 'c', stem: [], light: [[6, -2, 1, 2]] },
    { id: 'bar', tier: 'c', stem: [], light: [[5, -1, 3]] },
    { id: 'orb', tier: 'c', stem: [], light: [[5, -2, 3, 2]] },
    { id: 'tee', tier: 'c', stem: [[6, -1]], light: [[5, -2, 3]] },
    { id: 'leaf', tier: 'u', stem: [[6, -1]], light: [[7, -2]] },
    { id: 'sprout', tier: 'u', stem: [[6, -1]], light: [[5, -2], [7, -2]] },
    { id: 'twin', tier: 'u', stem: [[5, -1, 3]], light: [[5, -2], [7, -2]] },
    { id: 'arrow', tier: 'u', stem: [[6, -1]], light: [[5, -1], [7, -1], [6, -2]] },
    { id: 'flag', tier: 'u', stem: [[6, -2, 1, 2]], light: [[7, -2, 2]] },
    { id: 'beam', tier: 'u', stem: [], light: [[4, -1, 5]] },
    { id: 'chunk', tier: 'u', stem: [], light: [[6, -2, 2, 2]] },
    { id: 'cup', tier: 'r', stem: [], light: [[5, -1, 3], [5, -2], [7, -2]] },
    { id: 'hook', tier: 'r', stem: [[6, -1], [7, -1]], light: [[8, -2]] },
    { id: 'dish', tier: 'r', stem: [[6, -1]], light: [[4, -2, 5]] },
  ]);

  // Eye colours: all dark enough to keep 4.5:1 on every palette and on cream.
  const EYES = Object.freeze([
    { id: 'ink', tier: 'c', L: null },
    { id: 'navy', tier: 'c', L: 0.25, C: 0.07, h: 255 },
    { id: 'cocoa', tier: 'c', L: 0.25, C: 0.05, h: 55 },
    { id: 'forest', tier: 'u', L: 0.25, C: 0.06, h: 145 },
    { id: 'plum', tier: 'u', L: 0.25, C: 0.07, h: 320 },
    { id: 'teal', tier: 'u', L: 0.25, C: 0.05, h: 195 },
    { id: 'wine', tier: 'r', L: 0.25, C: 0.08, h: 15 },
    { id: 'violet', tier: 'r', L: 0.25, C: 0.09, h: 290 },
  ]);

  // Cheeks show when a clip blushes; `always` keeps them on, softer.
  const CHEEKS = Object.freeze([
    { id: 'pink', tier: 'c', fill: '#ff8fa3', always: false },
    { id: 'peach', tier: 'c', fill: '#ffb08a', always: false },
    { id: 'lilac', tier: 'u', fill: '#c9a7ff', always: false },
    { id: 'coral', tier: 'u', fill: '#ff7a70', always: false },
    { id: 'rosy', tier: 'u', fill: '#ff8fa3', always: true },
    { id: 'freckles', tier: 'r', fill: 'shadow', always: true, cells: [[2, 5], [9, 5], [2, 7], [9, 7]] },
  ]);

  // Character: rhythm of fidgets and how big reactions are (bit-director.js).
  const TEMPERAMENTS = Object.freeze(['lively', 'calm', 'curious', 'sleepy', 'dramatic', 'shy'].map((id) => ({ id, tier: 'c' })));

  // A favourite fidget, played twice as often (ids from bit-clips.js).
  const QUIRKS = Object.freeze(
    ['hop', 'spin', 'wave', 'antennaSpark', 'dance', 'sneeze', 'wink', 'peek', 'whistle', 'juggle', 'cool', 'reading'].map((id) => ({ id, tier: 'c' })),
  );

  // Chiptune voice: pitch multiplier and oscillator for Bit's sounds.
  const VOICES = Object.freeze(
    [['low', 0.8, 'square'], ['warm', 0.9, 'triangle'], ['mid', 1, 'square'], ['soft', 1, 'triangle'], ['bright', 1.12, 'square'], ['tiny', 1.25, 'triangle'], ['buzzy', 0.95, 'sawtooth'], ['chirpy', 1.35, 'square']].map(
      ([id, pitch, wave]) => ({ id, tier: 'c', pitch, wave }),
    ),
  );

  return { TIER_ODDS, HUES, TONES, CLASSIC, CLASSIC_ODDS, SHINY_ODDS, PATTERNS, PATTERN_COLORS, TIPS, EYES, CHEEKS, TEMPERAMENTS, QUIRKS, VOICES };
});
