'use strict';
// What a Bit is given for free, as a pure step over the model (model.js): while a season runs
// (bit-wardrobe.js seasonsOn), its items are given on the first day the Bit is seen, and stay
// for good. The sheet shows only the seasons running and the items owned: the rest come as a
// surprise. Everything else is earned (traits), a supporter's (keep.js) or bought (keep.js).

const wardrobe = require('../shared/src/bit-wardrobe.js');

/** The running seasons' items the Bit does not have yet, added. */
function seasonal(model, now) {
  if (!model.bit) return model;
  const running = new Set(wardrobe.seasonsOn(now, model.bit.born));
  const add = wardrobe.ITEMS.filter((it) => it.source === 'season' && running.has(it.season) && !model.owned.includes(it.id));
  return add.length ? { ...model, owned: [...model.owned, ...add.map((it) => it.id)] } : model;
}

/** The seasons running for this Bit now: the sheet shows their items, never the ones to come. */
const running = (model, now) => (model.bit ? wardrobe.seasonsOn(now, model.bit.born) : []);

module.exports = { seasonal, running };
