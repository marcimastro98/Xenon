// The Bit items made on the hub (server/bit/items.js): every item of the hub's list rebuilt and
// checked against every wardrobe rule before the wardrobe takes it, the list kept on disk so the
// items draw offline, an item once seen never forgotten, and the hub asked again only when the list
// is old. Then GET /api/bit hands the items to every surface. Every name and seed here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wardrobe = require('../shared/src/bit-wardrobe.js');
const Model = require('../bit/model.js');
const { createBitStore } = require('../bit/store.js');
const { createRoutes } = require('../bit/handlers.js');
const { createBitItems, itemOf, LANGS, FILE } = require('../bit/items.js');

const HUB = require('./fixtures/bit-hub-items.json');
const [CROWN, CAPE] = HUB;
const HOUR = 60 * 60 * 1000;
const SEED = '0123456789abcdef';
const shopHat = (more = {}) => ({
  id: 'testTopHat', slot: 'head', source: 'shop', price: 120,
  layers: [{ fill: '#3a3f4a', cells: [[3, 2, 6]] }], names: { en: 'Top hat', it: 'Cilindro' }, ...more,
});

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-bit-items-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeHub(items) {
  const hub = { calls: 0, answer: { ok: true, items } };
  hub.post = async (path) => {
    hub.calls++;
    assert.equal(path, '/bit/items');
    if (hub.answer instanceof Error) throw hub.answer;
    return hub.answer;
  };
  return hub;
}

test('an item from the hub keeps only what the wardrobe knows, and every rule holds', () => {
  assert.equal(LANGS.length, 11);
  const it = itemOf({ ...CROWN, extra: '<script>', names: { ...CROWN.names, xx: 'no' } });
  assert.deepEqual(Object.keys(it), ['id', 'slot', 'source', 'month', 'layers', 'names']);
  assert.deepEqual(Object.keys(it.names), LANGS);
  assert.deepEqual(itemOf(shopHat()).names, { en: 'Top hat', it: 'Cilindro' }, 'a missing language falls back to English when drawn');
  const refused = {
    'an id of the code': shopHat({ id: 'beanie' }),
    'a bad id': shopHat({ id: '../x' }),
    'a trait item': shopHat({ source: 'trait' }),
    'a slot that is not one': shopHat({ slot: 'tail' }),
    'a price out of range': shopHat({ price: 5 }),
    'a supporter item with no month': { ...CROWN, month: 'December' },
    'over the antenna stem': shopHat({ layers: [{ fill: '#ffffff', cells: [[6, 0]] }] }),
    'over an antenna tip': shopHat({ layers: [{ fill: '#ffffff', cells: [[5, -3, 3, 2]] }] }),
    'outside the scene': shopHat({ layers: [{ fill: '#ffffff', cells: [[20, 1]] }] }),
    'a fill that is not a colour': shopHat({ layers: [{ fill: 'url(x)', cells: [[3, 1]] }] }),
    'too many cells': shopHat({ layers: [{ fill: '#ffffff', cells: [[-3, 2, 18, 9]] }] }),
    'no English name': shopHat({ names: { it: 'Cilindro' } }),
    'a name on two lines': shopHat({ names: { en: `Top${String.fromCharCode(0x2028)}hat` } }),
    'a name turned around': shopHat({ names: { en: `Top${String.fromCharCode(0x202e)}hat` } }),
    'a name too long': shopHat({ names: { en: 'x'.repeat(41) } }),
  };
  for (const [why, raw] of Object.entries(refused)) assert.equal(itemOf(raw), null, why);
  assert.equal(itemOf(null), null);
  assert.equal(itemOf('crown'), null);
});

test('the hub list joins the wardrobe, is kept on disk, and draws again offline after a restart', async (t) => {
  const dataDir = tempDir(t);
  const warned = [];
  const hub = fakeHub([...HUB, shopHat(), shopHat({ id: 'testBad', price: 9999 })]);
  let now = 1_800_000_000_000;
  const items = createBitItems({ dataDir, post: hub.post, warn: (m) => warned.push(m), now: () => now });
  assert.equal(await items.refresh(), true, 'the first list changes the wardrobe');
  assert.equal(hub.calls, 1);
  assert.equal(wardrobe.item('testTopHat').names.it, 'Cilindro');
  assert.equal(wardrobe.item('testBad'), null, 'a broken item is dropped');
  assert.deepEqual(items.status(), { items: 4, offered: 4, fetchedAt: now, dropped: 1 });
  assert.match(warned.join('\n'), /1 item\(s\) from the hub were dropped/);
  assert.equal(await items.refresh(), false, 'a fresh list is not asked again');
  now += 7 * HOUR;
  assert.equal(await items.refresh(), false, 'the same list changes nothing');
  assert.equal(hub.calls, 2);
  const kept = JSON.parse(readFileSync(join(dataDir, FILE), 'utf8'));
  assert.deepEqual(kept.items.map((it) => it.id), ['crown', 'cape', 'wings', 'testTopHat']);

  hub.answer = new Error('offline');
  const again = createBitItems({ dataDir, post: hub.post, now: () => now });
  await again.ready();
  assert.equal(again.status().items, 4, 'read back from disk');
  assert.equal(await again.refresh(), false, 'the list on disk is fresh: no call');
  now += 7 * HOUR;
  assert.equal(await again.refresh(), false, 'the hub cannot be reached: the items stay');
  assert.equal(await again.refresh(), false);
  assert.equal(hub.calls, 3, 'after a failure the hub is left alone for a while');
  assert.ok(wardrobe.item('crown'));
});

test('an item the hub stops offering is never forgotten: whoever owns it keeps wearing it', async (t) => {
  const dataDir = tempDir(t);
  const hub = fakeHub([CROWN, shopHat()]);
  let now = 1_800_000_000_000;
  const items = createBitItems({ dataDir, post: hub.post, now: () => now });
  await items.refresh();
  hub.answer = { ok: true, items: [CAPE] };
  now += 7 * HOUR;
  assert.equal(await items.refresh(), true);
  assert.equal(wardrobe.item('crown').offered, false, 'no longer offered');
  assert.equal(wardrobe.item('cape').offered, true);
  const egg = Model.normalize({ eggAt: '2026-01-01T00:00:00.000Z' });
  const at = new Date('2026-12-05T12:00:00Z');
  const born = Model.hatched(egg, { seed: SEED, number: 7, born: at.toISOString(), sig: 'made-up' }, at).model;
  const model = Model.normalize({ ...born, owned: [...born.owned, 'crown'], worn: ['crown'] });
  const view = Model.view(model, at);
  assert.deepEqual(view.worn, ['crown']);
  const ids = view.items.map((it) => it.id);
  assert.ok(ids.includes('crown') && ids.includes('cape') && !ids.includes('testTopHat'), 'owned or offered, nothing else');
});

test('a list on disk is data like any other: broken items are dropped there too', async (t) => {
  const dataDir = tempDir(t);
  writeFileSync(join(dataDir, FILE), JSON.stringify({ v: 1, fetchedAt: 99e12, offered: ['testOdd', 'nope'], items: [shopHat({ id: 'testOdd' }), shopHat({ id: 'beanie' }), 'x'] }));
  const items = createBitItems({ dataDir, post: async () => { throw new Error('offline'); }, now: () => 1_800_000_000_000 });
  await items.ready();
  assert.deepEqual(items.status(), { items: 1, offered: 1, fetchedAt: 0, dropped: 0 }, 'a time in the future is not trusted');
  writeFileSync(join(dataDir, FILE), '{ not json');
  const warned = [];
  const broken = createBitItems({ dataDir, post: async () => null, warn: (m) => warned.push(m) });
  await broken.ready();
  assert.equal(broken.status().items, 0);
  assert.match(warned[0], /could not be read/);
});

test('GET /api/bit waits for the list on disk, then a newer hub list reaches every surface', async (t) => {
  const dataDir = tempDir(t);
  const store = createBitStore({ dataDir });
  const at = new Date();
  const egg = Model.normalize({ eggAt: '2026-01-01T00:00:00.000Z' });
  await store.update(() => ({ model: Model.hatched(egg, { seed: SEED, number: 7, born: at.toISOString(), sig: 'made-up' }, at).model }));
  const told = [];
  let ready = 0;
  let news = true;
  const items = { ready: async () => { ready++; }, refresh: async () => { const n = news; news = false; return n; } };
  const routes = createRoutes({ store, hatch: { hatch: async () => ({}) }, founder: async () => false, items, changed: (bit) => told.push(bit) });
  const call = () => new Promise((resolve) => routes['GET /api/bit'](null, null, { json: resolve }, {}));
  const first = await call();
  assert.equal(first.ok, true);
  assert.ok(Array.isArray(first.bit.items), 'the hub items ride with the view');
  await new Promise((r) => setImmediate(r));
  assert.equal(ready, 1);
  assert.equal(told.length, 1, 'the new items are told once');
  await call();
  await new Promise((r) => setImmediate(r));
  assert.equal(told.length, 1, 'nothing new, nothing told');
});
