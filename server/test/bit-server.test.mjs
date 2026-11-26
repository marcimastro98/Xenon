// The person's own Bit on the server (server/bit/): the file, the hatch with a
// stand-in hub, what it learns and what the routes answer. Every seed and name
// here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Model = require('../bit/model.js');
const Traits = require('../bit/traits.js');
const { createBitStore } = require('../bit/store.js');
const { createHatch, LOCAL_AFTER_MS } = require('../bit/hatch.js');
const { createRoutes } = require('../bit/handlers.js');

const SEED = '0123456789abcdef';
const NOON = new Date(2026, 11, 3, 12, 0);

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-bit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const hubSays = (answer) => async () => answer;
const born = { ok: true, seed: SEED, number: 1284, born: '2026-12-03T11:00:00.000Z', sig: 'made-up' };

test('a new egg is written once, with founder decided at that moment', async (t) => {
  const dir = tempDir(t);
  const store = createBitStore({ dataDir: dir });
  assert.equal(store.onDisk(), false);
  await store.create(true);
  await store.create(false);
  const saved = JSON.parse(readFileSync(join(dir, 'bit.json'), 'utf8'));
  assert.equal(saved.founder, true);
  assert.equal(saved.bit, null);
});

test('the hub hatches the egg: number, gift, first day', async (t) => {
  const store = createBitStore({ dataDir: tempDir(t) });
  await store.create(false);
  const hatch = createHatch({ store, scopedId: async () => 'x'.repeat(64), post: hubSays(born), now: () => NOON });
  assert.deepEqual(await hatch.hatch(), { ok: true, hatched: true });
  const v = Model.view(await store.ready(), new Date());
  assert.equal(v.number, 1284);
  assert.equal(v.local, false);
  assert.equal(v.days, 1);
  assert.equal(v.stage, 'baby');
  assert.equal(v.worn.length, 1, 'a gift at birth');
  assert.deepEqual(await hatch.hatch(), { ok: true, already: true });
});

test('without the hub the egg waits, and after three days a local Bit is born', async (t) => {
  const store = createBitStore({ dataDir: tempDir(t), now: () => NOON });
  await store.create(false);
  let at = NOON.getTime();
  let calls = 0;
  const post = async () => { calls++; throw new Error('offline'); };
  const hatch = createHatch({ store, scopedId: async () => 'id', post, now: () => new Date(at) });
  const first = await hatch.hatch();
  assert.equal(first.error, 'waiting');
  await hatch.hatch();
  assert.equal(calls, 1, 'not asked again before the retry time');
  at += LOCAL_AFTER_MS;
  assert.equal((await hatch.hatch()).hatched, true);
  const v = Model.view(await store.ready(), new Date());
  assert.equal(v.local, true);
  assert.equal(v.number, null);
  assert.match(v.seed, /^[0-9a-f]{16}$/);
});

test('a hub answer that is not a birth is never stored', async (t) => {
  for (const answer of [{ ok: true, seed: 'nothex', number: 3 }, { ok: true, seed: SEED, number: 0 }, { ok: false, error: 'limit' }, null]) {
    const store = createBitStore({ dataDir: tempDir(t), now: () => NOON });
    await store.create(false);
    const hatch = createHatch({ store, scopedId: async () => 'id', post: hubSays(answer), now: () => NOON });
    assert.equal((await hatch.hatch()).ok, false);
    assert.equal((await store.ready()).bit, null);
  }
});

test('two taps at once make one call to the hub', async (t) => {
  const store = createBitStore({ dataDir: tempDir(t) });
  await store.create(false);
  let calls = 0;
  const hatch = createHatch({ store, scopedId: async () => 'id', post: async () => { calls++; return born; } });
  await Promise.all([hatch.hatch(), hatch.hatch()]);
  assert.equal(calls, 1);
});

test('a broken file is kept aside, never written over', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'bit.json'), '{not json');
  const store = createBitStore({ dataDir: dir, warn: () => {} });
  await store.create(false);
  assert.ok(existsSync(join(dir, 'bit.json.broken')));
  assert.equal(JSON.parse(readFileSync(join(dir, 'bit.json'), 'utf8')).bit, null);
});

test('the file read back is cleaned: broken item ids, bad seeds and names', () => {
  const m = Model.normalize({
    bit: { seed: SEED.toUpperCase(), number: 5 }, worn: ['beanie', 'not an id', 'hubHat', 'cap'], owned: ['beanie', 42, 'hubHat', '<b>'], name: 'x'.repeat(80),
  });
  assert.equal(m.bit, null);
  // 'hubHat' is no item the code knows: a hub item (items.js) whose list is not loaded yet keeps its place.
  assert.deepEqual(m.worn, ['cap', 'hubHat'], 'one item per slot, the last one wins, then the ids still unknown');
  assert.deepEqual(m.owned, ['beanie', 'hubHat']);
  assert.equal([...m.name].length, 24);
  assert.equal(Model.cleanName('mail me at someone@example.com'), '');
  assert.equal(Model.cleanName('  Pixel\u0000  the   Brave '), 'Pixel the Brave');
  // The hub's publicName list (test/bit-public.test.js): a name kept here is the one its page shows.
  // The same in other spellings: fullwidth dot, at and digits, small dot, styled letters, other digits.
  const spelt = ['example．com', 'me＠example', 'call ５５５０１２', 'bit﹒ly', '𝐰𝐰𝐰.x', 'x。com', '१२३४५'];
  for (const bad of ['me@example.com', 'https://x', 'www.example', 'example.com', 'discord.gg', 'bit.ly', 'call 5550123', ...spelt]) {
    assert.equal(Model.cleanName(bad), '', bad);
  }
  assert.equal(Model.cleanName('Zo' + '́'.repeat(30)), 'Zó́́', 'a pile of combining marks keeps two');
  assert.equal(Model.cleanName('नमस्ते'), 'नमस्ते');
  assert.equal(Model.cleanName('R2-D2'), 'R2-D2');
});

test('a Bit wears only what it owns, and the founder gets the medal', () => {
  const egg = Model.normalize({ founder: true });
  assert.equal(Model.wear(egg, ['beanie']).error, 'egg');
  const { model } = Model.hatched(egg, born, NOON);
  assert.equal(Model.wear(model, ['crown']).error, 'not_owned');
  assert.ok(Model.ownedItems(model).includes('medal'));
  assert.deepEqual(Model.wear(model, ['medal']).model.worn, ['medal']);
  assert.equal(Model.wear(model, 'medal').error, 'bad_request');
});

test('days of use count once a day and move the stage', () => {
  let m = Model.hatched(Model.normalize({}), born, NOON).model;
  assert.equal(Model.countDay(m, NOON), null);
  for (let d = 1; d < 7; d++) m = Model.countDay(m, new Date(2026, 11, 3 + d, 9)).model;
  assert.equal(Model.view(m, new Date()).stage, 'young');
  assert.equal(Model.stageOf(365), 'legend');
});

test('traits: minutes add up, a night counts once per date, and only with someone there', () => {
  let c = Traits.normalizeCounts({});
  const night = new Date(2026, 11, 3, 2, 30);
  c = Traits.add(c, { gaming: true, active: false }, night);
  assert.equal(c.gaming, 1);
  assert.equal(c.night, 0, 'a dashboard on all night is not a night owl');
  c = Traits.add(c, { active: true }, night);
  c = Traits.add(c, { active: true }, new Date(2026, 11, 3, 3, 0));
  assert.equal(c.night, 1);
  c = Traits.add({ ...c, gaming: 20 * 60 - 1 }, { gaming: true }, NOON);
  assert.deepEqual(Traits.earnedItems(c), ['headset']);
  assert.ok(Model.ownedItems(Model.normalize({ traits: c })).includes('headset'));
});

test('what leaves the server: progress of each trait, never the counts', () => {
  const m = Model.hatched(Model.normalize({ traits: { gaming: 600 } }), born, NOON).model;
  const v = Model.view(m, new Date());
  assert.equal(v.traits.find((x) => x.id === 'gamer').progress, 0.5);
  assert.ok(!('gaming' in v) && !JSON.stringify(v).includes('"gaming"'));
});

// ── routes ──

function harness(t, { fresh = false, settings = {} } = {}) {
  const store = createBitStore({ dataDir: tempDir(t) });
  const hatch = createHatch({ store, scopedId: async () => 'id', post: hubSays(born) });
  let asked = null;
  const told = [];
  const routes = createRoutes({ store, hatch, founder: async (f) => { asked = f; return !f; }, settings: () => settings, changed: (b) => told.push(b) });
  const call = async (key, body) => {
    const out = [];
    const ctx = { json: (v) => out.push(v), readBody: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? {})) };
    await routes[key]({}, {}, ctx, { FRESH_INSTALL: fresh });
    return out[0];
  };
  return { call, store, asked: () => asked, told: () => told };
}

test('GET /api/bit writes the egg once and tells whether it hatched', async (t) => {
  const h = harness(t, { fresh: true });
  const r = await h.call('GET /api/bit');
  assert.equal(r.ok, true);
  assert.equal(r.bit.hatched, false);
  assert.equal(r.bit.founder, false);
  assert.equal(h.asked(), true, 'the fresh start was handed to the founder test');
  assert.equal(h.store.onDisk(), true);
});

test('hatch, wear and name through the routes; bad bodies are refused', async (t) => {
  const h = harness(t);
  assert.equal((await h.call('POST /api/bit/wear', { worn: [] })).error, 'egg');
  const hatched = await h.call('POST /api/bit/hatch');
  assert.equal(hatched.bit.number, 1284);
  assert.equal((await h.call('POST /api/bit/name', { name: 'Pixel' })).bit.name, 'Pixel');
  assert.equal((await h.call('POST /api/bit/name', { name: 'call 5551234567' })).error, 'bad_name');
  assert.equal((await h.call('POST /api/bit/wear', '[1,2]')).error, 'bad_request');
  assert.equal((await h.call('POST /api/bit/wear', '{oops')).error, 'bad_request');
  assert.equal((await h.call('POST /api/bit/wear', { worn: ['crown'] })).error, 'not_owned');
});

test('prefs: only known keys and values, and every change is told to all surfaces', async (t) => {
  const h = harness(t);
  const r = await h.call('POST /api/bit/prefs', { classic: true, reactions: 'few' });
  assert.equal(r.bit.everywhere, false);
  assert.equal(r.bit.reactionsPerHour, 2);
  assert.equal(h.told().length, 1);
  assert.equal((await h.call('POST /api/bit/prefs', { place: 'ceiling' })).error, 'bad_value');
  assert.equal((await h.call('POST /api/bit/prefs', { sounds: 'yes' })).error, 'bad_value');
  assert.equal((await h.call('POST /api/bit/prefs', { card: 'gold' })).error, 'bad_value');
  assert.equal((await h.call('POST /api/bit/prefs', { card: 'stage' })).bit.prefs.card, 'stage');
  // Where it was dragged: fractions of the screen, rounded; out of the screen is refused, null is its corner.
  assert.deepEqual((await h.call('POST /api/bit/prefs', { spot: { x: 0.25, y: 0.1234 }, roam: 'stay' })).bit.prefs.spot, { x: 0.25, y: 0.123 });
  assert.equal((await h.call('POST /api/bit/prefs', { spot: { x: 2, y: 0 } })).error, 'bad_value');
  assert.equal((await h.call('POST /api/bit/prefs', { spot: 'left' })).error, 'bad_value');
  assert.equal((await h.call('POST /api/bit/prefs', { roam: 'fly' })).error, 'bad_value');
  assert.equal((await h.call('POST /api/bit/prefs', { warp: 'beam' })).bit.prefs.warp, 'beam');
  assert.equal((await h.call('POST /api/bit/prefs', { warp: 'explode' })).error, 'bad_value');
  assert.equal((await h.call('POST /api/bit/prefs', { spot: null, roam: 'walk' })).bit.prefs.spot, null);
  // On the desktop: the main screen or off, and where along the bar it was dragged (null: its usual place).
  assert.equal((await h.call('POST /api/bit/prefs', { deskX: 0.4213 })).bit.prefs.deskX, 0.421);
  assert.equal((await h.call('POST /api/bit/prefs', { desk: 'off' })).bit.prefs.desk, 'off');
  assert.equal((await h.call('POST /api/bit/prefs', { desk: 'everywhere' })).error, 'bad_value');
  assert.equal((await h.call('POST /api/bit/prefs', { deskX: 1.5 })).error, 'bad_value');
  assert.equal((await h.call('POST /api/bit/prefs', { deskX: '0.5' })).error, 'bad_value');
  assert.equal((await h.call('POST /api/bit/prefs', { deskX: null })).bit.prefs.deskX, null);
  await h.call('POST /api/bit/prefs', { classic: true });
  assert.equal(h.told().length, 8, 'no change, nothing told');
});

test('the Vitals Bit becomes the companion where it lived', async (t) => {
  const h = harness(t, { settings: { vitals: { pet: { enabled: true, position: 'topbar', sounds: true } } } });
  const r = await h.call('GET /api/bit');
  assert.deepEqual(r.bit.prefs, { place: 'topbar', reactions: 'normal', sounds: true, classic: false, pose: '', card: 'plain', roam: 'mix', warp: 'any', spot: null, desk: 'main', deskX: null });
  const { prefsFromVitals } = require('../bit/handlers.js');
  assert.equal(prefsFromVitals({ vitals: { pet: { enabled: false, position: 'topbar' } } }).place, 'corner');
});

test('founder: a fresh start or a birth seen days ago is not one; an old install is', async (t) => {
  const { founder } = require('../bit/index.js');
  const dir = tempDir(t);
  const now = Date.parse('2026-12-10T12:00:00Z');
  assert.equal(await founder(true, dir, now), false);
  assert.equal(await founder(false, dir, now), true, 'no record: older than the version ping');
  writeFileSync(join(dir, 'version-ping.json'), JSON.stringify({ born: 'known', first: '2026-12-09' }));
  assert.equal(await founder(false, dir, now), false);
  writeFileSync(join(dir, 'version-ping.json'), JSON.stringify({ born: 'known', first: '2026-11-01' }));
  assert.equal(await founder(false, dir, now), true);
  require('../bit/index.js').stop();
});

test('a backup carries a hatched Bit and gives the same one back; an egg travels as nothing', async (t) => {
  const { createBitBackup } = require('../bit/backup.js');
  const from = createBitStore({ dataDir: tempDir(t) });
  await from.create(true);
  assert.equal(await createBitBackup({ store: from }).save(), null);
  await from.update((m) => Model.hatched(m, born, NOON));
  await from.update((m) => Model.rename(m, 'Pixel'));
  const section = JSON.parse(JSON.stringify(await createBitBackup({ store: from }).save()));
  const to = createBitStore({ dataDir: tempDir(t) });
  await createBitBackup({ store: to }).restore(section);
  const v = Model.view(await to.ready(), new Date());
  assert.equal(v.seed, SEED);
  assert.equal(v.name, 'Pixel');
  assert.equal(v.founder, true);
  assert.equal(to.onDisk(), true);
  await assert.rejects(createBitBackup({ store: to }).restore({ bit: { seed: 'x' } }), /bit_shape/);
});

test('the engine puts the Bit in the backup and gives it back', async () => {
  const { engineSource } = await import('./engine-source.mjs');
  const server = engineSource();
  assert.match(server, /bit: await require\('\.\/bit\/index\.js'\)\.backup\.save\(\)\.catch\(\(\) => null\)/);
  assert.match(server, /if \(d\.bit && typeof d\.bit === 'object'\) await apply\('bit', \(\) => require\('\.\/bit\/index\.js'\)\.backup\.restore\(d\.bit\)\);/);
});
