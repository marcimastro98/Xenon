'use strict';
// What a Bit is given for free, as a pure step over the model (model.js): while a season runs
// (seasonsOn, over bit-wardrobe.js SEASONS), its items are given on the first day the Bit is seen, and stay
// for good. The sheet shows only the seasons running and the items owned: the rest come as a
// surprise. Everything else is earned (traits), a supporter's (keep.js) or bought (keep.js).

const wardrobe = require('../shared/src/bit-wardrobe.js');

const md = (m, d) => m * 100 + d;
const DAY_MS = 864e5;

/**
 * The seasons running on `date` (local time). `born` is when the Bit hatched:
 * from its first birthday on, the week that starts on that day is its own season.
 * @param {Date} date @param {string|number} [born]
 * @returns {string[]}
 */
function seasonsOn(date, born) {
  const today = md(date.getMonth() + 1, date.getDate());
  const out = [];
  for (const [id, span] of Object.entries(wardrobe.SEASONS)) {
    if (!span) continue;
    const from = md(span[0][0], span[0][1]);
    const to = md(span[1][0], span[1][1]);
    if (from <= to ? today >= from && today <= to : today >= from || today <= to) out.push(id);
  }
  const b = born ? new Date(born) : null;
  if (b && !Number.isNaN(b.getTime()) && date.getFullYear() > b.getFullYear()) {
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    // Last year's too: a week that starts on 29 December runs into January.
    const week = (year) => {
      const since = Math.round((day - new Date(year, b.getMonth(), b.getDate()).getTime()) / DAY_MS);
      return year > b.getFullYear() && since >= 0 && since < 7;
    };
    if (week(date.getFullYear()) || week(date.getFullYear() - 1)) out.push('birthday');
  }
  return out;
}

/** The running seasons' items the Bit does not have yet, added. */
function seasonal(model, now) {
  if (!model.bit) return model;
  const running = new Set(seasonsOn(now, model.bit.born));
  const add = wardrobe.ITEMS.filter((it) => it.source === 'season' && running.has(it.season) && !model.owned.includes(it.id));
  return add.length ? { ...model, owned: [...model.owned, ...add.map((it) => it.id)] } : model;
}

/** The seasons running for this Bit now: the sheet shows their items, never the ones to come. */
const running = (model, now) => (model.bit ? seasonsOn(now, model.bit.born) : []);

module.exports = { seasonal, running, seasonsOn };
