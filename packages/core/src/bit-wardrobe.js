;((root, factory) => {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bitWardrobe = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  /* What a personal Bit can wear, as plain data on Bit's 12x12 grid. A fill is '#rrggbb' or a
   * role of the Bit's own palette ('body', 'accent', 'shadow', 'cream', 'line', 'ink'), so the
   * same beanie looks different on every Bit. One item per slot; `back` is drawn behind the
   * body, the rest over it, face items under the eyes so Bit always looks out (a part may set
   * `layer` itself). Every item keeps the antenna (x 6, y <= 1) and its tip visible (the tip
   * shows mood), stays above the floor and fits every mood pose (where a big move such as
   * moonwalk would take it off the stage, x -3..14 y -5..12, bit.js sets it down for that
   * clip), and has no hearts, confetti or glows: validate() and the Bit Lab check it. Ids are
   * permanent (owned items are stored by id). A season item has its season (SEASONS), a
   * supporter item its month ('YYYY-MM', one a month) and a shop item its fixed price in Sparks;
   * those two are kept through the hub's key entryOf(item) (server/bit/keep.js). */

  const SLOTS = Object.freeze(['head', 'face', 'neck', 'back', 'feet', 'hand']);
  const SOURCES = Object.freeze(['trait', 'season', 'supporter', 'shop', 'founder']);
  const SLATE = '#3b4250';
  const WHITE = '#f0f3f1';
  const GOLD = '#ffd75e';
  const PINK = '#ff8fa3';
  const RED = '#ff5a6e';
  const BROWN = '#8a5a3b';
  const LEAF = '#6fcf73';
  const ORANGE = '#ff8c2e';
  /** @typedef {{ id: string, slot: string, source: string, season?: string, month?: string, price?: number, layers: readonly object[] }} WardrobeItem */
  /** @type {(id: string, slot: string, source: string, layers: object[], extra?: { season?: string, month?: string, price?: number }) => Readonly<WardrobeItem>} */
  const I = (id, slot, source, layers, extra = {}) => Object.freeze({ id, slot, source, ...extra, layers: Object.freeze(layers) });
  const S = (season) => ({ season });
  const M = (month) => ({ month });
  const P = (price) => ({ price });
  const ARM = { fill: 'body', cells: [[10, 6]] };

  // When each season's items are given: [month, day] to [month, day], both kept.
  // 'birthday' is the Bit's own week, from the day it hatched (seasonsOn).
  const SEASONS = Object.freeze({
    winter: [[12, 1], [2, 29]],
    christmas: [[12, 15], [12, 31]],
    spring: [[3, 20], [6, 20]],
    summer: [[6, 21], [9, 22]],
    halloween: [[10, 15], [11, 2]],
    birthday: null,
  });

  const ITEMS = Object.freeze([
    // head: around the antenna, never over it
    I('beanie', 'head', 'shop', [
      { fill: 'accent', cells: [[3, 1, 3], [7, 1, 2]] },
      { fill: 'cream', cells: [[2, 2, 8]] },
    ], P(50)),
    I('cap', 'head', 'shop', [
      { fill: 'accent', cells: [[3, 1, 3], [7, 1, 2], [3, 2, 6]] },
      { fill: SLATE, cells: [[9, 2, 2]] },
    ], P(50)),
    I('crown', 'head', 'supporter', [
      { fill: GOLD, cells: [[3, 1], [5, 1], [7, 1], [8, 1], [3, 2, 6]] },
      { fill: '#ff5a6e', cells: [[4, 2]] },
      { fill: '#5eead4', cells: [[7, 2]] },
    ], M('2026-12')),
    I('nightcap', 'head', 'trait', [
      { fill: '#8ab4f8', cells: [[3, 1, 3], [7, 1, 2], [2, 2, 8], [9, 1], [10, 2, 1, 2]] },
      { fill: WHITE, cells: [[10, 4]] },
    ]),
    I('headband', 'head', 'trait', [{ fill: '#ff5a6e', cells: [[3, 2, 6], [9, 2], [10, 3]] }]),
    I('flower', 'head', 'season', [
      { fill: '#ff8fa3', cells: [[8, 0], [7, 1], [9, 1], [8, 2]] },
      { fill: GOLD, cells: [[8, 1]] },
    ], S('spring')),
    I('headset', 'head', 'trait', [
      { fill: SLATE, cells: [[3, 1, 3], [7, 1, 2], [2, 2], [9, 2], [2, 8], [3, 9]] },
      { fill: 'accent', cells: [[1, 3, 1, 4], [10, 3, 1, 4]] },
    ]),
    I('earbuds', 'head', 'trait', [{ fill: WHITE, cells: [[1, 4, 1, 2], [10, 4, 1, 2]] }]),
    // face: under the eyes
    // round rims around each eye, open at the inner corners so they read as glasses, not a visor
    I('glasses', 'face', 'trait', [{ fill: 'line', cells: [[4, 3], [7, 3], [3, 4, 1, 2], [8, 4, 1, 2], [5, 4, 2], [4, 6], [7, 6]] }]),
    I('monocle', 'face', 'shop', [
      { fill: GOLD, cells: [[6, 3, 3], [6, 6, 3], [6, 4, 1, 2], [8, 4, 1, 2]] },
      { fill: GOLD, o: 0.7, cells: [[9, 7], [9, 8]] },
    ], P(150)),
    // neck
    I('scarf', 'neck', 'season', [{ fill: 'accent', cells: [[2, 8, 8], [8, 9, 1, 2]] }], S('winter')),
    // Two wings that flare at the tips, round a darker knot: upright bars by the mouth read as fangs.
    I('bowtie', 'neck', 'shop', [
      { fill: 'accent', cells: [[3, 8], [8, 8], [3, 9, 2], [7, 9, 2]] },
      { fill: 'shadow', cells: [[5, 9, 2]] },
    ], P(50)),
    I('medal', 'neck', 'founder', [
      { fill: 'accent', cells: [[4, 8], [7, 8], [5, 9, 2]] },
      { fill: GOLD, cells: [[5, 10, 2]] },
    ]),
    // back: behind the body, with front straps where needed
    I('backpack', 'back', 'trait', [
      { fill: 'accent', cells: [[1, 4, 1, 5], [10, 4, 1, 5]] },
      { fill: SLATE, layer: 'over', cells: [[2, 3, 1, 6], [9, 3, 1, 6]] },
    ]),
    I('cape', 'back', 'supporter', [{ fill: 'accent', cells: [[1, 3, 1, 7], [10, 3, 1, 7], [1, 10, 2], [9, 10, 2]] }], M('2027-01')),
    // White on top, grey feathers under: all-white wings vanish on a light theme.
    I('wings', 'back', 'supporter', [
      { fill: WHITE, cells: [[0, 3, 2], [0, 4, 2], [10, 3, 2], [10, 4, 2]] },
      { fill: '#c3cad3', cells: [[-1, 4], [12, 4]] },
      { fill: '#8d97a5', cells: [[0, 5, 2], [10, 5, 2]] },
    ], M('2027-02')),
    // feet
    I('sneakers', 'feet', 'shop', [
      { fill: WHITE, cells: [[3, 10, 2], [7, 10, 2]] },
      { fill: 'accent', cells: [[4, 10], [8, 10]] },
    ], P(50)),
    I('boots', 'feet', 'shop', [{ fill: '#8a5a3b', cells: [[3, 9, 2, 2], [7, 9, 2, 2]] }], P(100)),
    // hand: held on Bit's right, with a little arm in its own colour
    I('mug', 'hand', 'trait', [
      { fill: 'body', cells: [[10, 6]] },
      { fill: WHITE, cells: [[11, 5, 2, 3], [13, 6]] },
      { fill: 'accent', cells: [[11, 6, 2]] },
    ]),
    I('camera', 'hand', 'trait', [
      { fill: 'body', cells: [[10, 6]] },
      { fill: SLATE, cells: [[11, 5, 3, 2]] },
      { fill: 'cream', cells: [[12, 5]] },
    ]),

    // ── more of the shop ──
    I('bandana', 'head', 'shop', [
      { fill: 'accent', cells: [[3, 1, 3], [7, 1, 2], [2, 2, 8], [10, 2], [11, 3]] },
      { fill: 'cream', cells: [[4, 1], [8, 1], [3, 2], [6, 2], [9, 2]] },
    ], P(50)),
    I('bucketHat', 'head', 'shop', [
      { fill: '#d9c9a3', cells: [[3, 0, 3], [7, 0, 2], [1, 2, 10]] },
      { fill: 'shadow', cells: [[3, 1, 3], [7, 1, 2]] },
    ], P(50)),
    I('bow', 'head', 'shop', [{ fill: PINK, cells: [[8, 0, 1, 3], [10, 0, 1, 3]] }, { fill: '#e0607a', cells: [[9, 1]] }], P(50)),
    I('beret', 'head', 'shop', [{ fill: 'accent', cells: [[2, 1, 4], [7, 1, 3], [1, 2, 9]] }, { fill: 'shadow', cells: [[4, 0]] }], P(100)),
    I('seedling', 'head', 'shop', [{ fill: '#3f9a4a', cells: [[8, 0, 1, 2]] }, { fill: LEAF, cells: [[7, 0], [9, -1, 2]] }], P(100)),
    I('goggles', 'head', 'shop', [{ fill: SLATE, cells: [[2, 2, 8]] }, { fill: '#5eead4', cells: [[3, 1, 2], [7, 1, 2]] }], P(100)),
    I('topHat', 'head', 'shop', [{ fill: SLATE, cells: [[3, 0, 3], [7, 0, 3], [1, 2, 10]] }, { fill: 'accent', cells: [[3, 1, 3], [7, 1, 3]] }], P(200)),
    I('kerchief', 'neck', 'shop', [
      { fill: 'accent', cells: [[3, 8, 6], [4, 9, 4], [5, 10, 2]] },
      { fill: 'cream', cells: [[4, 8], [7, 8], [6, 9]] },
    ], P(50)),
    I('collar', 'neck', 'shop', [{ fill: RED, cells: [[2, 8, 8]] }, { fill: GOLD, cells: [[5, 9, 2]] }], P(50)),
    I('tie', 'neck', 'shop', [{ fill: 'shadow', cells: [[5, 8, 2]] }, { fill: 'accent', cells: [[5, 9, 2, 2]] }], P(100)),
    I('slippers', 'feet', 'shop', [{ fill: PINK, cells: [[2, 10, 3], [7, 10, 3]] }, { fill: WHITE, cells: [[2, 10], [9, 10]] }], P(50)),
    I('rainBoots', 'feet', 'shop', [{ fill: GOLD, cells: [[3, 9, 2, 2], [7, 9, 2, 2]] }], P(100)),
    I('lollipop', 'hand', 'shop', [
      ARM,
      { fill: WHITE, cells: [[11, 4, 1, 3]] },
      { fill: PINK, cells: [[11, 2, 2, 2]] },
      { fill: WHITE, cells: [[12, 2]] },
    ], P(50)),
    I('book', 'hand', 'shop', [
      ARM,
      { fill: '#4a7bd0', cells: [[11, 5, 2, 3]] },
      { fill: WHITE, cells: [[13, 5, 1, 3]] },
    ], P(100)),
    I('gamepad', 'hand', 'shop', [
      ARM,
      { fill: SLATE, cells: [[11, 6, 3, 2]] },
      { fill: WHITE, cells: [[11, 6]] },
      { fill: RED, cells: [[13, 6]] },
    ], P(100)),
    I('balloon', 'hand', 'shop', [
      ARM,
      { fill: 'line', cells: [[11, 2, 1, 5]] },
      { fill: RED, cells: [[10, -1, 3, 3]] },
      { fill: WHITE, cells: [[10, -1]] },
    ], P(200)),
    I('guitar', 'back', 'shop', [
      { fill: '#c47a3d', cells: [[10, 6, 2, 3]] },
      { fill: SLATE, cells: [[11, 7], [10, 1, 2]] },
      { fill: BROWN, cells: [[10, 2, 1, 4]] },
    ], P(200)),

    // ── seasons: given to every Bit while the season lasts, kept for good ──
    I('santaHat', 'head', 'season', [
      { fill: '#e5484d', cells: [[3, 1, 3], [7, 1, 2], [8, 0, 2], [10, 1]] },
      { fill: WHITE, cells: [[2, 2, 8], [11, 2]] },
    ], S('christmas')),
    I('antlers', 'head', 'season', [{ fill: BROWN, cells: [[3, 0, 1, 2], [2, -1], [1, -2, 2], [8, 0, 1, 2], [9, -1], [9, -2, 2]] }], S('winter')),
    I('witchHat', 'head', 'season', [
      { fill: '#5b3f8c', cells: [[1, 2, 10], [4, 0, 2], [7, 0, 3], [10, -1]] },
      { fill: ORANGE, cells: [[3, 1, 3], [7, 1, 3]] },
    ], S('halloween')),
    I('pumpkin', 'hand', 'season', [
      ARM,
      { fill: ORANGE, cells: [[11, 5, 3, 3]] },
      { fill: '#3f9a4a', cells: [[12, 4]] },
      { fill: SLATE, cells: [[11, 6], [13, 6]] },
    ], S('halloween')),
    I('partyHat', 'head', 'season', [
      { fill: 'accent', cells: [[8, 1, 3], [9, 0]] },
      { fill: WHITE, cells: [[9, 1]] },
      { fill: GOLD, cells: [[9, -1]] },
    ], S('birthday')),
    I('lei', 'neck', 'season', [
      { fill: PINK, cells: [[2, 8], [4, 8], [6, 8], [8, 8]] },
      { fill: GOLD, cells: [[3, 8], [5, 8], [7, 8], [9, 8]] },
    ], S('summer')),
    I('iceCream', 'hand', 'season', [
      ARM,
      { fill: PINK, cells: [[11, 4, 2, 2]] },
      { fill: '#d9a066', cells: [[11, 6, 2], [11, 7]] },
    ], S('summer')),
  ]);

  const BY_ID = new Map(ITEMS.map((i) => [i.id, i]));

  const item = (id) => BY_ID.get(id) || null;

  function cellsOf(it) {
    const out = [];
    for (const part of it.layers) {
      for (const [x, y, w = 1, h = 1] of part.cells) {
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out.push([x + i, y + j]);
      }
    }
    return out;
  }

  /**
   * The problems with one item, empty when it keeps every rule. `tipCells`
   * are the antenna-tip cells of the Bit (or of every tip), which must stay
   * visible.
   * @returns {string[]}
   */
  function validate(it, tipCells = []) {
    const errors = [];
    if (!/^[a-z][a-zA-Z0-9]{1,31}$/.test(it.id || '')) errors.push('id');
    if (!SLOTS.includes(it.slot)) errors.push('slot');
    if (!SOURCES.includes(it.source)) errors.push('source');
    if (it.source === 'season' && !Object.hasOwn(SEASONS, it.season)) errors.push('season');
    if (it.source === 'supporter' && !MONTH.test(it.month || '')) errors.push('month');
    if (it.source === 'shop' && !(Number.isInteger(it.price) && it.price >= 50 && it.price <= 300)) errors.push('price');
    const keep = new Set([[6, 0], [6, 1], ...tipCells].map(([x, y]) => `${x},${y}`));
    for (const [x, y] of cellsOf(it)) {
      if (x < -3 || x > 14 || y < -5 || y > 10) errors.push(`outside ${x},${y}`);
      if (keep.has(`${x},${y}`)) errors.push(`covers antenna ${x},${y}`);
    }
    for (const part of it.layers) {
      if (!/^(#[0-9a-f]{6}|body|accent|shadow|cream|line|ink)$/i.test(part.fill)) errors.push(`fill ${part.fill}`);
      if (part.layer && !['behind', 'over', 'face'].includes(part.layer)) errors.push(`layer ${part.layer}`);
    }
    return errors;
  }

  const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
  /** The month of `date` as 'YYYY-MM', in UTC: the app and the hub agree on when a month starts. */
  const monthOf = (date) => date.toISOString().slice(0, 7);
  /** The supporter items out by `date`: this month's and every one before it. */
  const supporterOut = (date) => ITEMS.filter((it) => it.source === 'supporter' && it.month <= monthOf(date));
  /** The hub's key of a supporter or shop item: 'bit-' and the id in kebab case (topHat → bit-top-hat). */
  const entryOf = (it) => `bit-${it.id.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
  /** What a Bit hatches wearing, one of the shop's cheapest, from `pick` in [0, 1) (its seed's 'birth-gift' stream): the hub reads it the same way. */
  const birthItem = (pick) => { const first = ITEMS.filter((it) => it.source === 'shop' && it.price === 50); return first[Math.min(first.length - 1, Math.floor(pick * first.length))].id; };

  const md = (m, d) => m * 100 + d;
  const DAY_MS = 864e5;
  /**
   * The seasons running on `date` (local time). `born` is when the Bit hatched:
   * from its first birthday on, the week that starts on that day is its own season.
   * @returns {string[]}
   */
  function seasonsOn(date, born) {
    const today = md(date.getMonth() + 1, date.getDate());
    const out = [];
    for (const [id, span] of Object.entries(SEASONS)) {
      if (!span) continue;
      const from = md(...span[0]);
      const to = md(...span[1]);
      if (from <= to ? today >= from && today <= to : today >= from || today <= to) out.push(id);
    }
    const b = born ? new Date(born) : null;
    if (b && !Number.isNaN(b.getTime()) && date.getFullYear() > b.getFullYear()) {
      const birthday = new Date(date.getFullYear(), b.getMonth(), b.getDate());
      const since = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() - birthday.getTime()) / DAY_MS);
      if (since >= 0 && since < 7) out.push('birthday');
    }
    return out;
  }

  /** One item per slot, last one wins; unknown ids are dropped. */
  function outfit(ids) {
    const bySlot = new Map();
    for (const id of ids || []) {
      const it = item(id);
      if (it) bySlot.set(it.slot, it);
    }
    return SLOTS.map((s) => bySlot.get(s)).filter(Boolean);
  }

  return { SLOTS, SOURCES, SEASONS, ITEMS, item, cellsOf, validate, outfit, seasonsOn, monthOf, supporterOut, entryOf, birthItem };
});
