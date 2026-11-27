// What a Bit is given and what it can buy (server/bit/seasons.js, bit-wardrobe.js): the season's
// items, given to every Bit and kept; the item it hatches wearing; the shop's fixed prices; no daily
// gift any more, and an older file's gift dropped on read. Every seed here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Seasons = require('../bit/seasons.js');
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

test('every item is valid, every season item has a season the wardrobe knows, no daily item is left', () => {
  for (const it of wardrobe.ITEMS) {
    assert.deepEqual(wardrobe.validate(it), [], it.id);
    if (it.source === 'season') assert.ok(Object.hasOwn(wardrobe.SEASONS, it.season), it.id);
  }
  assert.ok(!wardrobe.SOURCES.includes('daily'));
  assert.ok(!('TIERS' in wardrobe));
});

test('the shop sells at three fixed prices, with something at each', () => {
  const shop = wardrobe.ITEMS.filter((it) => it.source === 'shop');
  assert.ok(shop.length >= 20, `${shop.length} items`);
  assert.deepEqual([...new Set(shop.map((it) => it.price))].sort((a, b) => a - b), [50, 100, 150, 200]);
  for (const it of shop) assert.match(wardrobe.entryOf(it), /^bit-[a-z]+(-[a-z]+)*$/, it.id);
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

test('the view names only the seasons running: what comes next stays a surprise', () => {
  assert.deepEqual(Seasons.running(Model.normalize({}), day(12, 20)), [], 'an egg has no season');
  const m = hatchedOn(day(12, 20));
  assert.ok(Seasons.running(m, day(12, 20)).includes('winter'));
  assert.deepEqual(Model.view(m, day(12, 20)).seasons, Seasons.running(m, day(12, 20)));
  assert.ok(!Model.view(m, day(12, 20)).seasons.includes('halloween'));
  assert.equal(Seasons.seasonal(Model.normalize({}), day(12, 20)).owned.length, 0, 'an egg is given nothing');
});

test("the Bit's birthday week starts a year after it hatched", () => {
  assert.deepEqual(Seasons.seasonsOn(day(4, 10), day(4, 10).toISOString()).filter((s) => s === 'birthday'), []);
  const born = day(4, 10, 2026).toISOString();
  assert.ok(Seasons.seasonsOn(day(4, 10, 2027), born).includes('birthday'));
  assert.ok(Seasons.seasonsOn(day(4, 16, 2027), born).includes('birthday'));
  assert.ok(!Seasons.seasonsOn(day(4, 17, 2027), born).includes('birthday'));
  assert.ok(!Seasons.seasonsOn(day(4, 9, 2027), born).includes('birthday'));
});

test('it hatches wearing one of the shop\'s cheapest, the same for the same seed, as the hub reads it', () => {
  const it = wardrobe.item(Model.birthGift(SEED));
  assert.equal(it.source, 'shop');
  assert.equal(it.price, 50);
  assert.equal(Model.birthGift(SEED), Model.birthGift(SEED));
  const m = hatchedOn(day(6, 1));
  assert.ok(m.owned.includes(it.id) && m.worn.includes(it.id));
  const seen = new Set(Array.from({ length: 200 }, (_, i) => Model.birthGift(seedOf(i * 7919 + 1))));
  assert.ok(seen.size > 3, 'different Bits hatch wearing different things');
  assert.equal(wardrobe.birthItem(0.9999999), wardrobe.birthItem(0.9999999), 'the edge of the range still picks an item');
});

test("the file read back drops an older file's daily gift and bolts", () => {
  const m = Model.normalize({ bolts: 40, gift: { day: '2026-12-03', item: 'cap' }, owned: ['cap'] });
  assert.ok(!('gift' in m) && !('bolts' in m));
  assert.deepEqual(m.owned, ['cap'], 'what it was given stays its own');
});

test('the routes have no gift or pick any more; the view carries no gift', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-bit-seasons-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createBitStore({ dataDir: dir });
  const birth = { ok: true, seed: SEED, number: 7, born: new Date().toISOString(), sig: 'made-up' };
  const hatch = createHatch({ store, scopedId: async () => 'id', post: async () => birth });
  const routes = createRoutes({ store, hatch, founder: async () => false });
  assert.equal(routes['POST /api/bit/gift'], undefined);
  assert.equal(routes['POST /api/bit/pick'], undefined);
  let out;
  await routes['POST /api/bit/hatch']({}, {}, { json: (v) => { out = v; }, readBody: async () => '{}' }, {});
  assert.equal(out.ok, true);
  assert.ok(!('gifts' in out.bit) && !('gift' in out.bit));
  assert.ok(Array.isArray(out.bit.seasons));
});

test('the wardrobe says every item, season and way to get one in words (en.js, the other languages follow it)', () => {
  const en = readFileSync(new URL('../js/i18n/en.js', import.meta.url), 'utf8');
  const has = (key) => en.includes(`  ${key}: '`);
  const missing = [
    ...wardrobe.ITEMS.map((it) => `mybit_item_${it.id}`),
    ...Object.keys(wardrobe.SEASONS).map((s) => `mybit_season_${s}`),
    ...wardrobe.SOURCES.filter((s) => s !== 'trait' && s !== 'founder').map((s) => `mybit_get_${s}`),
    ...wardrobe.SOURCES.filter((s) => s !== 'founder').flatMap((s) => [`mybit_group_${s}`, `mybit_group_${s}_line`]),
    'mybit_season_now', 'mybit_look_odds',
  ].filter((key) => !has(key));
  assert.deepEqual(missing, []);
  for (const gone of ['mybit_gift_open', 'mybit_tier_c', 'mybit_get_daily', 'mybit_group_daily', 'mybit_rare_palette']) {
    assert.ok(!has(gone), `${gone} is gone`);
  }
});

test('a birthday week that starts at the end of December runs into January', () => {
  const born = new Date(2024, 11, 29).toISOString();
  assert.ok(Seasons.seasonsOn(new Date(2026, 0, 2), born).includes('birthday'), 'day five of the week, in the new year');
  assert.ok(Seasons.seasonsOn(new Date(2025, 11, 30), born).includes('birthday'));
  assert.ok(!Seasons.seasonsOn(new Date(2026, 0, 5), born).includes('birthday'), 'the week is over');
  assert.ok(!Seasons.seasonsOn(new Date(2025, 0, 2), born).includes('birthday'), 'not the week it was born');
});
