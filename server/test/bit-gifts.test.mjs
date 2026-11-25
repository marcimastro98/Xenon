// What a Bit is given for free (server/bit/gifts.js): the daily gift and its
// odds, bolts for a duplicate and what they buy, and the season's items.
// Every seed here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Gifts = require('../bit/gifts.js');
const Model = require('../bit/model.js');
const wardrobe = require('../shared/src/bit-wardrobe.js');
const { createBitStore } = require('../bit/store.js');
const { createHatch } = require('../bit/hatch.js');
const { createRoutes } = require('../bit/handlers.js');

const SEED = '0123456789abcdef';
const day = (m, d, y = 2026) => new Date(y, m - 1, d, 12, 0);
const hatchedOn = (now, extra = {}) => {
  const egg = Model.normalize({ eggAt: '2026-01-01T00:00:00.000Z' });
  const birth = { seed: SEED, number: 7, born: new Date(now).toISOString(), sig: 'made-up' };
  return { ...Model.hatched(egg, birth, now).model, ...extra };
};
const seedOf = (n) => n.toString(16).padStart(16, '0');

test('every daily item has a tier and every season item a season the wardrobe knows', () => {
  for (const it of wardrobe.ITEMS) {
    assert.deepEqual(wardrobe.validate(it), [], it.id);
    if (it.source === 'daily') assert.ok(wardrobe.TIERS.includes(it.tier), it.id);
    if (it.source === 'season') assert.ok(Object.hasOwn(wardrobe.SEASONS, it.season), it.id);
  }
  for (const tier of wardrobe.TIERS) {
    assert.ok(wardrobe.ITEMS.some((it) => it.source === 'daily' && it.tier === tier), `a ${tier} item`);
  }
});

test('the draw is the same for the same seed and date, and new every day', () => {
  assert.equal(Gifts.draw(SEED, '2026-12-03').id, Gifts.draw(SEED, '2026-12-03').id);
  const week = new Set(Array.from({ length: 30 }, (_, i) => Gifts.draw(SEED, `2026-12-${String(i + 1).padStart(2, '0')}`).id));
  assert.ok(week.size > 5, 'a month brings several items');
});

test('the odds the sheet states are the odds the draw keeps', () => {
  const n = 20000;
  const count = { c: 0, u: 0, r: 0 };
  for (let i = 0; i < n; i++) count[Gifts.draw(seedOf(i * 7919 + 1), '2026-12-03').tier]++;
  for (const tier of ['c', 'u', 'r']) {
    assert.ok(Math.abs(count[tier] / n - Gifts.ODDS[tier]) < 0.015, `${tier}: ${count[tier] / n}`);
  }
});

test('the gift opens once a day: a new item, then bolts for one already owned', () => {
  const now = day(12, 3);
  assert.equal(Gifts.open(Model.normalize({}), now, []).error, 'egg');
  const m = hatchedOn(now);
  const it = Gifts.draw(SEED, '2026-12-03');
  const first = Gifts.open(m, now, Model.ownedItems(m)).model;
  assert.deepEqual(first.gift, { day: '2026-12-03', item: it.id, bolts: m.owned.includes(it.id) ? Gifts.BOLTS_FOR[it.tier] : 0 });
  assert.ok(first.owned.includes(it.id));
  assert.equal(Gifts.open(first, day(12, 3), Model.ownedItems(first)).error, 'opened');
  assert.equal(Gifts.ready(first, day(12, 4)), true);
  // The same item again (a new day with it owned): bolts by its tier, nothing lost.
  const again = Gifts.open({ ...first, gift: null }, now, Model.ownedItems(first)).model;
  assert.equal(again.bolts, first.bolts + Gifts.BOLTS_FOR[it.tier]);
  assert.equal(again.gift.bolts, Gifts.BOLTS_FOR[it.tier]);
  assert.deepEqual(again.owned, first.owned);
});

test('bolts pick an everyday item at its price, and nothing else', () => {
  const m = hatchedOn(day(12, 3), { bolts: 7 });
  const common = wardrobe.ITEMS.find((it) => it.tier === 'c' && !m.owned.includes(it.id));
  const rare = wardrobe.ITEMS.find((it) => it.tier === 'r');
  assert.equal(Gifts.pick(m, 'crown', m.owned).error, 'bad_item');
  assert.equal(Gifts.pick(m, 'nope', m.owned).error, 'bad_item');
  assert.equal(Gifts.pick(m, m.worn[0], m.owned).error, 'owned');
  assert.equal(Gifts.pick(m, rare.id, m.owned).error, 'bolts');
  const out = Gifts.pick(m, common.id, m.owned).model;
  assert.equal(out.bolts, 7 - Gifts.PRICE.c);
  assert.ok(out.owned.includes(common.id));
});

test('a season gives its items to every Bit, kept after it ends', () => {
  const ids = (m) => new Set(m.owned);
  const xmas = ids(hatchedOn(day(12, 20)));
  for (const id of ['santaHat', 'scarf', 'antlers']) assert.ok(xmas.has(id), id);
  assert.ok(!xmas.has('witchHat'));
  // Winter runs over the new year.
  assert.ok(ids(hatchedOn(day(1, 15))).has('scarf'));
  const halloween = Model.countDay(hatchedOn(day(10, 1)), day(10, 31)).model;
  assert.ok(ids(halloween).has('witchHat') && ids(halloween).has('pumpkin'));
  const after = Model.countDay(halloween, day(11, 20)).model;
  assert.ok(ids(after).has('witchHat'), 'kept');
});

test("the Bit's birthday week starts a year after it hatched", () => {
  assert.deepEqual(wardrobe.seasonsOn(day(4, 10), day(4, 10).toISOString()).filter((s) => s === 'birthday'), []);
  const born = day(4, 10, 2026).toISOString();
  assert.ok(wardrobe.seasonsOn(day(4, 10, 2027), born).includes('birthday'));
  assert.ok(wardrobe.seasonsOn(day(4, 16, 2027), born).includes('birthday'));
  assert.ok(!wardrobe.seasonsOn(day(4, 17, 2027), born).includes('birthday'));
  assert.ok(!wardrobe.seasonsOn(day(4, 9, 2027), born).includes('birthday'));
});

test('the birth gift is a common item, the same for the same seed', () => {
  assert.equal(wardrobe.item(Model.birthGift(SEED)).tier, 'c');
  assert.equal(Model.birthGift(SEED), Model.birthGift(SEED));
});

test('the file read back keeps bolts in range and drops a gift of an unknown item', () => {
  const m = Model.normalize({ bolts: -4, gift: { day: '2026-12-03', item: 'nope' } });
  assert.equal(m.bolts, 0);
  assert.equal(m.gift, null);
  assert.equal(Model.normalize({ bolts: 1e9 }).bolts, Gifts.MAX_BOLTS);
  assert.deepEqual(Model.normalize({ gift: { day: '2026-12-03', item: 'cap', bolts: 2 } }).gift, { day: '2026-12-03', item: 'cap', bolts: 2 });
});

test('through the routes: open, open again, and pick; the view says when the next gift is ready', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-bit-gift-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createBitStore({ dataDir: dir });
  const birth = { ok: true, seed: SEED, number: 7, born: new Date().toISOString(), sig: 'made-up' };
  const hatch = createHatch({ store, scopedId: async () => 'id', post: async () => birth });
  const routes = createRoutes({ store, hatch, founder: async () => false });
  const call = async (key, body) => {
    let out;
    await routes[key]({}, {}, { json: (v) => { out = v; }, readBody: async () => JSON.stringify(body ?? {}) }, {});
    return out;
  };
  assert.equal((await call('POST /api/bit/gift')).error, 'egg');
  const born = await call('POST /api/bit/hatch');
  assert.equal(born.bit.gifts.gift.ready, true);
  const opened = await call('POST /api/bit/gift');
  assert.equal(opened.ok, true);
  assert.equal(opened.bit.gifts.gift.ready, false);
  assert.ok(opened.bit.owned.includes(opened.bit.gifts.gift.last.item));
  assert.equal((await call('POST /api/bit/gift')).error, 'opened');
  // Whatever today drew, a rare item not owned costs more bolts than one day gives.
  const rare = wardrobe.ITEMS.find((it) => it.tier === 'r' && !opened.bit.owned.includes(it.id));
  assert.equal((await call('POST /api/bit/pick', { item: rare.id })).error, 'bolts');
  assert.deepEqual(opened.bit.gifts.prices, Gifts.PRICE);
});

test('the wardrobe says every item, tier, season and way to get one in words (en.js, the other languages follow it)', async () => {
  const { readFileSync } = await import('node:fs');
  const en = readFileSync(new URL('../js/i18n/en.js', import.meta.url), 'utf8');
  const has = (key) => en.includes(`  ${key}: '`);
  const missing = [
    ...wardrobe.ITEMS.map((it) => `mybit_item_${it.id}`),
    ...wardrobe.TIERS.map((tier) => `mybit_tier_${tier}`),
    ...Object.keys(wardrobe.SEASONS).map((s) => `mybit_season_${s}`),
    ...wardrobe.SOURCES.filter((s) => s !== 'trait').map((s) => `mybit_get_${s}`),
  ].filter((key) => !has(key));
  assert.deepEqual(missing, []);
});
