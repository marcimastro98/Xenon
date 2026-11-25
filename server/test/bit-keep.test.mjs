// Supporter and shop items kept for good (server/bit/keep.js, POST /api/bit/claim|buy):
// the wardrobe's months and prices, the hub's key for each item, a month still to come
// refused before the hub is asked, what the hub answers passed on, and the item added
// to what the Bit owns only when the hub said yes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wardrobe = require('../shared/src/bit-wardrobe.js');
const Model = require('../bit/model.js');
const { createBitStore } = require('../bit/store.js');
const { createKeep } = require('../bit/keep.js');
const { createRoutes } = require('../bit/handlers.js');

const SEED = '0123456789abcdef';
const supporters = wardrobe.ITEMS.filter((it) => it.source === 'supporter').sort((a, b) => a.month.localeCompare(b.month));
const shopItems = wardrobe.ITEMS.filter((it) => it.source === 'shop');
const startOf = (month) => new Date(`${month}-01T00:00:00.000Z`);

async function hatchedStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-bit-keep-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createBitStore({ dataDir: dir });
  const now = new Date();
  const egg = Model.normalize({ eggAt: '2026-01-01T00:00:00.000Z' });
  const birth = { seed: SEED, number: 7, born: now.toISOString(), sig: 'made-up' };
  await store.update(() => ({ model: Model.hatched(egg, birth, now).model }));
  return store;
}

function fakeHub() {
  const calls = [];
  const answers = { redeem: { ok: true }, buy: { ok: true, bought: true, balance: 40 } };
  return {
    calls, answers,
    redeem: async (o) => { calls.push(['redeem', o]); return answers.redeem; },
    buy: async (o) => { calls.push(['buy', o]); return answers.buy; },
  };
}

test('every supporter item has its own month and every shop item a price in range', () => {
  for (const it of [...supporters, ...shopItems]) assert.deepEqual(wardrobe.validate(it), [], it.id);
  assert.equal(new Set(supporters.map((it) => it.month)).size, supporters.length, 'one item a month');
  assert.deepEqual(wardrobe.validate({ ...supporters[0], month: '2026-13' }), ['month']);
  assert.deepEqual(wardrobe.validate({ ...shopItems[0], price: 20 }), ['price']);
  assert.deepEqual(wardrobe.validate({ ...shopItems[0], price: 75.5 }), ['price']);
});

test("an item's hub key is its id in kebab case, and a month opens on its first day in UTC", () => {
  assert.equal(wardrobe.entryOf({ id: 'topHat' }), 'bit-top-hat');
  assert.equal(wardrobe.entryOf({ id: 'crown' }), 'bit-crown');
  const first = supporters[0];
  const opens = startOf(first.month);
  assert.equal(wardrobe.supporterOut(new Date(opens.getTime() - 1)).includes(first), false);
  assert.equal(wardrobe.supporterOut(opens).includes(first), true);
  assert.equal(wardrobe.monthOf(opens), first.month);
});

test('a supporter item: refused before its month without asking the hub, then kept once', async (t) => {
  const store = await hatchedStore(t);
  const hub = fakeHub();
  const [first] = supporters;
  let now = new Date(startOf(first.month).getTime() - 1000);
  const keep = createKeep({ store, redeem: hub.redeem, buy: hub.buy, now: () => now });

  assert.deepEqual(await keep.claim(first.id), { ok: false, error: 'not_yet' });
  assert.equal(hub.calls.length, 0);

  now = startOf(first.month);
  hub.answers.redeem = { ok: false, error: 'expired' };
  assert.deepEqual(await keep.claim(first.id), { ok: false, error: 'expired' });
  assert.equal((await store.ready()).owned.includes(first.id), false, 'nothing kept on a no');

  hub.answers.redeem = { ok: true, key: 'ignored' };
  assert.deepEqual(await keep.claim(first.id), { ok: true });
  assert.deepEqual(hub.calls.at(-1), ['redeem', { entryId: wardrobe.entryOf(first), code: '' }]);
  assert.ok((await store.ready()).owned.includes(first.id));

  const asked = hub.calls.length;
  assert.deepEqual(await keep.claim(first.id), { ok: true }, 'kept already');
  assert.equal(hub.calls.length, asked, 'the hub is not asked again');
});

test('a shop item: the box goes to the hub, a short balance comes back, a yes keeps it', async (t) => {
  const store = await hatchedStore(t);
  const hub = fakeHub();
  const keep = createKeep({ store, redeem: hub.redeem, buy: hub.buy });
  const [it] = shopItems;

  hub.answers.buy = { ok: false, error: 'no_sparks', balance: 10, price: it.price };
  assert.deepEqual(await keep.shop(it.id, 'item-2026-11'), { ok: false, error: 'no_sparks', balance: 10, price: it.price });
  assert.deepEqual(hub.calls.at(-1), ['buy', { entryId: wardrobe.entryOf(it), code: '', consent: 'item-2026-11' }]);

  hub.answers.buy = { ok: true, bought: true, balance: 40 };
  assert.deepEqual(await keep.shop(it.id, 'item-2026-11'), { ok: true, bought: true, balance: 40 });
  assert.ok((await store.ready()).owned.includes(it.id));
  assert.deepEqual(await keep.shop(it.id), { ok: true, bought: false }, 'owned: no second charge');
});

test('the wrong door, an egg and a hub that cannot be reached are told apart', async (t) => {
  const hub = fakeHub();
  const dir = mkdtempSync(join(tmpdir(), 'xenon-bit-keep-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const eggKeep = createKeep({ store: createBitStore({ dataDir: dir }), redeem: hub.redeem, buy: hub.buy });
  assert.equal((await eggKeep.shop(shopItems[0].id, 'x')).error, 'egg');

  const store = await hatchedStore(t);
  const keep = createKeep({ store, redeem: async () => { throw new Error('offline'); }, buy: async () => null, now: () => startOf(supporters[0].month) });
  assert.equal((await keep.claim(shopItems[0].id)).error, 'bad_item', 'a shop item is not claimed with the pass');
  assert.equal((await keep.shop(supporters[0].id)).error, 'bad_item', 'a supporter item is not for sale');
  assert.equal((await keep.claim('nope')).error, 'bad_item');
  assert.equal((await keep.claim(supporters[0].id)).error, 'network');
  assert.equal((await keep.shop(shopItems[0].id, 'x')).error, 'network');
  assert.deepEqual((await store.ready()).owned.filter((id) => wardrobe.item(id)?.source === 'shop'), []);
});

test('through the routes: an item is a string, a yes answers with the Bit, a no with the reason', async (t) => {
  const store = await hatchedStore(t);
  const hub = fakeHub();
  const keep = createKeep({ store, redeem: hub.redeem, buy: hub.buy });
  const hatch = { hatch: async () => ({ ok: false }) };
  const routes = createRoutes({ store, hatch, keep, founder: async () => false });
  const call = async (key, body) => {
    let out;
    await routes[key]({}, {}, { json: (v) => { out = v; }, readBody: async () => JSON.stringify(body ?? {}) }, {});
    return out;
  };
  const [it] = shopItems;
  assert.equal((await call('POST /api/bit/buy', { item: 7 })).ok, false);
  assert.equal(hub.calls.length, 0);
  hub.answers.buy = { ok: false, error: 'consent_required' };
  const no = await call('POST /api/bit/buy', { item: it.id, consent: 5 });
  assert.equal(no.error, 'consent_required');
  assert.equal(hub.calls.at(-1)[1].consent, undefined, 'only a string consent is passed on');
  assert.equal(no.bit.hatched, true, 'a no still carries the Bit');
  hub.answers.buy = { ok: true, bought: true, balance: 3 };
  const yes = await call('POST /api/bit/buy', { item: it.id, consent: 'item-2026-11' });
  assert.equal(yes.ok, true);
  assert.equal(yes.balance, 3);
  assert.ok(yes.bit.owned.includes(it.id));
});
