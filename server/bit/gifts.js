'use strict';
// What a Bit is given for free, as pure steps over the model (model.js):
//
//   - The daily gift: once per date, one item of the daily pool. Its tier is
//     drawn with the odds below (the sheet says them), then an item of that
//     tier. The draw comes from the seed and the date, so opening it again,
//     on another screen or after a restart, gives the same item: nothing to
//     reroll. It cannot be bought or hurried.
//   - Bolts: an item that is already owned becomes bolts, and bolts pick any
//     daily item at a fixed price. A duplicate is never a loss.
//   - Seasons: while a season runs (bit-wardrobe.js seasonsOn), its items are
//     given on the first day the Bit is seen, and stay for good.

const genome = require('../shared/src/bit-genome.js');
const wardrobe = require('../shared/src/bit-wardrobe.js');
const { dateKey } = require('./traits.js');

const ODDS = Object.freeze({ c: 0.7, u: 0.25, r: 0.05 });
const BOLTS_FOR = Object.freeze({ c: 1, u: 2, r: 4 });
const PRICE = Object.freeze({ c: 6, u: 12, r: 30 });
const MAX_BOLTS = 9999;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const pool = (tier) => wardrobe.ITEMS.filter((it) => it.source === 'daily' && it.tier === tier);

/** The gift fields of bit.json, whatever came from disk. */
function normalize(src) {
  const g = src.gift && typeof src.gift === 'object' ? src.gift : null;
  const bolts = Number.isSafeInteger(src.bolts) ? Math.max(0, Math.min(MAX_BOLTS, src.bolts)) : 0;
  const gift = g && DAY.test(g.day) && wardrobe.item(g.item)
    ? { day: g.day, item: g.item, bolts: Number.isSafeInteger(g.bolts) && g.bolts > 0 ? g.bolts : 0 }
    : null;
  return { bolts, gift };
}

/** The item a seed gets on a date: always the same one. */
function draw(seed, day) {
  const rand = genome.stream(seed, `gift:${day}`);
  const roll = rand();
  const tier = roll < ODDS.r ? 'r' : roll < ODDS.r + ODDS.u ? 'u' : 'c';
  const items = pool(tier);
  return items[Math.floor(rand() * items.length)];
}

const ready = (model, now) => !!model.bit && model.gift?.day !== dateKey(now);

/** Today's gift opens: the item, or bolts when it is already owned. */
function open(model, now, owned) {
  if (!model.bit) return { error: 'egg' };
  if (!ready(model, now)) return { error: 'opened' };
  const day = dateKey(now);
  const it = draw(model.bit.seed, day);
  const duplicate = owned.includes(it.id);
  const bolts = duplicate ? BOLTS_FOR[it.tier] : 0;
  return {
    model: {
      ...model,
      owned: duplicate ? model.owned : [...model.owned, it.id],
      bolts: Math.min(MAX_BOLTS, model.bolts + bolts),
      gift: { day, item: it.id, bolts },
    },
  };
}

/** Bolts pick one daily item the Bit does not have yet. */
function pick(model, id, owned) {
  if (!model.bit) return { error: 'egg' };
  const it = typeof id === 'string' ? wardrobe.item(id) : null;
  if (it?.source !== 'daily') return { error: 'bad_item' };
  if (owned.includes(it.id)) return { error: 'owned' };
  if (model.bolts < PRICE[it.tier]) return { error: 'bolts' };
  return { model: { ...model, owned: [...model.owned, it.id], bolts: model.bolts - PRICE[it.tier] } };
}

/** The running seasons' items the Bit does not have yet, added. */
function seasonal(model, now) {
  if (!model.bit) return model;
  const running = new Set(wardrobe.seasonsOn(now, model.bit.born));
  const add = wardrobe.ITEMS.filter((it) => it.source === 'season' && running.has(it.season) && !model.owned.includes(it.id));
  return add.length ? { ...model, owned: [...model.owned, ...add.map((it) => it.id)] } : model;
}

/** What the sheet shows: the gift's state and the shop of bolts. */
function view(model, now) {
  return {
    bolts: model.bolts,
    gift: { ready: ready(model, now), last: model.gift },
    odds: ODDS,
    prices: PRICE,
  };
}

module.exports = { ODDS, BOLTS_FOR, PRICE, MAX_BOLTS, normalize, draw, ready, open, pick, seasonal, view };
