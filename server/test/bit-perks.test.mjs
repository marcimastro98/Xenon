// The Bit's extras the hub may keep for supporters (server/bit/perks.js): free until the hub says
// otherwise, the gate only at choosing (what the person has is never taken away), the hub's word kept
// on disk with its items, an extra opened with the PC's pass for good (keep.js, POST /api/bit/perk,
// PC only), and the page's gold heart and its one way in (js/bit-companion/perks.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { readFileSync as browserSource } from './browser-source.mjs';
import { makeDom, settle } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const Perks = require('../bit/perks.js');
const Pocket = require('../bit/pocket.js');
const Model = require('../bit/model.js');
const { createBitStore } = require('../bit/store.js');
const { createKeep } = require('../bit/keep.js');
const { createRoutes } = require('../bit/handlers.js');
const { createBitActions } = require('../bit/actions.js');
const { createBitItems, FILE } = require('../bit/items.js');
const { REMOTE_ADMIN } = require('../paired/refused-paths.js');
const PAGE = browserSource(new URL('../js/bit-companion/perks.js', import.meta.url), 'utf8');

const SEED = '0123456789abcdef';
const NOW = new Date('2026-11-27T10:00:00.000Z');
const SUPPORTERS = { allScreens: 'supporter', moreKeys: 'supporter' };

async function hatchedStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-bit-perks-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); Perks.setAccess(null); });
  const store = createBitStore({ dataDir: dir });
  const egg = Model.normalize({ eggAt: '2026-01-01T00:00:00.000Z' });
  await store.update(() => ({ model: Model.hatched(egg, { seed: SEED, number: 7, born: NOW.toISOString(), sig: 'made-up' }, NOW).model }));
  return { store, dir };
}

test('free until the hub says otherwise; anything but "supporter" reads as free', () => {
  assert.deepEqual(Perks.IDS, ['allScreens', 'moreKeys']);
  assert.deepEqual(Perks.accessOf(null), { allScreens: 'free', moreKeys: 'free' });
  assert.deepEqual(Perks.accessOf({ allScreens: 'supporter', moreKeys: 'gold', other: 'supporter' }), { allScreens: 'supporter', moreKeys: 'free' });
  for (const id of Perks.IDS) assert.match(Perks.PERKS[id].source, /^[a-z0-9][a-z0-9_-]{0,23}$/, 'a support source the hub takes');
  assert.deepEqual(Perks.openedOf(['moreKeys', 'nope', 7]), ['moreKeys']);
  assert.deepEqual(Perks.openedOf('moreKeys'), []);
});

test('the gate is at choosing: every screen, a fifth key; never what the person already has', (t) => {
  t.after(() => Perks.setAccess(null));
  const keys = (n) => Pocket.IDS.slice(0, n);
  assert.equal(Perks.lockedBy({ desk: 'main', keys: [] }, { desk: 'all', keys: [] }, []), '', 'free: nothing locked');
  Perks.setAccess(SUPPORTERS);
  assert.equal(Perks.lockedBy({ desk: 'main', keys: [] }, { desk: 'all', keys: [] }, []), 'allScreens');
  assert.equal(Perks.lockedBy({ desk: 'all', keys: [] }, { desk: 'all', keys: [] }, []), '', 'chosen before the hub changed its word');
  assert.equal(Perks.lockedBy({ desk: 'main', keys: [] }, { desk: 'all', keys: [] }, ['allScreens']), '', 'opened');
  assert.equal(Perks.lockedBy({ keys: keys(4) }, { keys: keys(4) }, []), '');
  assert.equal(Perks.lockedBy({ keys: keys(4) }, { keys: keys(5) }, []), 'moreKeys');
  assert.equal(Perks.lockedBy({ keys: keys(6) }, { keys: keys(5) }, []), '', 'fewer keys than it had: fine');
  assert.equal(Perks.lockedBy({ keys: keys(4) }, { keys: keys(8) }, ['moreKeys']), '');
  assert.deepEqual(Perks.view(['moreKeys']), { allScreens: { access: 'supporter', open: false }, moreKeys: { access: 'supporter', open: true } });
});

test('the model: a locked choice answers the extra, an opened one is kept for good and shown', async (t) => {
  const { store } = await hatchedStore(t);
  Perks.setAccess(SUPPORTERS);
  const model = await store.ready();
  assert.deepEqual(model.perks, []);
  assert.deepEqual(Model.setPrefs(model, { desk: 'all' }), { error: 'locked', perk: 'allScreens' });
  assert.ok(Model.setPrefs(model, { desk: 'off' }).model, 'what is free still changes');
  const opened = Model.openPerk(model, 'allScreens').model;
  assert.deepEqual(opened.perks, ['allScreens']);
  assert.equal(Model.openPerk(opened, 'allScreens'), null);
  assert.equal(Model.openPerk(model, 'nope'), null);
  assert.equal(Model.setPrefs(opened, { desk: 'all' }).model.prefs.desk, 'all');
  assert.deepEqual(Model.normalize(JSON.parse(JSON.stringify(opened))).perks, ['allScreens'], 'read back from bit.json');
  assert.deepEqual(Model.view(opened, NOW).perks.allScreens, { access: 'supporter', open: true });
});

test('opening an extra: free or opened asks nothing, the hub\'s yes keeps it, its no is passed on', async (t) => {
  const { store } = await hatchedStore(t);
  const calls = [];
  let answer = { ok: false, error: 'no_code' };
  const keep = createKeep({ store, redeem: async (o) => { calls.push(o); return answer; }, buy: async () => null });
  assert.deepEqual(await keep.perk('allScreens'), { ok: true }, 'free');
  assert.equal(calls.length, 0);
  Perks.setAccess(SUPPORTERS);
  assert.deepEqual(await keep.perk('allScreens'), { ok: false, error: 'no_code' });
  assert.deepEqual(calls[0], { entryId: 'bit-perk-all-screens', code: '' });
  assert.deepEqual((await store.ready()).perks, [], 'nothing opened on a no');
  answer = { ok: true, key: 'ignored' };
  assert.deepEqual(await keep.perk('allScreens'), { ok: true });
  assert.deepEqual((await store.ready()).perks, ['allScreens']);
  assert.deepEqual(await keep.perk('allScreens'), { ok: true });
  assert.equal(calls.length, 2, 'opened: the hub is not asked again');
  assert.equal((await keep.perk('nope')).error, 'bad_item');
  const offline = createKeep({ store, redeem: async () => { throw new Error('offline'); }, buy: async () => null });
  assert.equal((await offline.perk('moreKeys')).error, 'network');
});

test('through the routes and the actions: locked names the extra, POST /api/bit/perk opens it, a phone never', async (t) => {
  const { store } = await hatchedStore(t);
  Perks.setAccess(SUPPORTERS);
  const keep = createKeep({ store, redeem: async () => ({ ok: true }), buy: async () => null });
  const routes = createRoutes({ store, hatch: { hatch: async () => ({ ok: false }) }, keep, founder: async () => false });
  const call = async (key, body) => {
    let out;
    await routes[key]({}, {}, { json: (v) => { out = v; }, readBody: async () => JSON.stringify(body ?? {}) }, {});
    return out;
  };
  assert.deepEqual(await call('POST /api/bit/prefs', { desk: 'all' }), { ok: false, error: 'locked', perk: 'allScreens' });
  const actions = createBitActions({ store, broadcast: () => {}, now: () => NOW });
  assert.deepEqual(await actions.run({ type: 'bitDesk', desk: 'all' }), { ok: false, error: 'locked', perk: 'allScreens' });
  assert.equal((await call('POST /api/bit/perk', { perk: 7 })).error, 'bad_request');
  const yes = await call('POST /api/bit/perk', { perk: 'allScreens' });
  assert.equal(yes.ok, true);
  assert.equal(yes.bit.perks.allScreens.open, true, 'answers with the Bit');
  assert.equal((await call('POST /api/bit/prefs', { desk: 'all' })).ok, true);
  assert.ok(REMOTE_ADMIN.has('/api/bit/perk'), 'it uses the pass: the PC only');
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.ok(server.includes("'/api/bit/buy', '/api/bit/perk'"), 'in CSRF_MUTATION_PATHS');
});

test('the hub\'s word comes with its items, is kept on disk and holds offline; an older hub changes nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-bit-perks-items-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); Perks.setAccess(null); });
  let answer = { ok: true, items: [], perks: { allScreens: 'supporter' } };
  const post = async () => answer;
  let now = 1_800_000_000_000;
  const items = createBitItems({ dataDir: dir, post, now: () => now });
  assert.equal(await items.refresh(), true, 'a new word is a change');
  assert.equal(Perks.access().allScreens, 'supporter');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, FILE), 'utf8')).perks, { allScreens: 'supporter', moreKeys: 'free' });
  answer = { ok: true, items: [] };
  now += 7 * 60 * 60 * 1000;
  assert.equal(await items.refresh(), false, 'a hub that says nothing of extras leaves them');
  assert.equal(Perks.access().allScreens, 'supporter');
  Perks.setAccess(null);
  await createBitItems({ dataDir: dir, post: async () => { throw new Error('offline'); }, now: () => now }).ready();
  assert.equal(Perks.access().allScreens, 'supporter', 'read back from disk');
});

// ── js/bit-companion/perks.js ───────────────────────────────────────────────

function pageRig({ perks = {}, saved = true, remote = false, answer = { ok: true } } = {}) {
  const { document } = makeDom();
  const posts = [];
  const sheets = [];
  const toasts = [];
  let state = { hatched: true, perks };
  const ctx = {
    console, Promise, Object, JSON, String, document,
    t: (key) => key,
    SERVER: '',
    BitApp: { state: () => state, heard: (next) => { state = next; } },
    XenonCredits: { supporterSaved: async () => saved },
    RemoteSurface: { isRemote: () => remote },
    SupportSheet: { open: (source) => sheets.push(source) },
    XenonToast: { show: (o) => toasts.push(o.message) },
    fetch: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { json: async () => answer };
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(PAGE, ctx);
  return { P: ctx.BitPerks, document, posts, sheets, toasts };
}

test('the page: a closed extra wears the gold heart, an open one nothing; eight keys only with the extra', () => {
  const closed = { allScreens: { access: 'supporter', open: false }, moreKeys: { access: 'supporter', open: false } };
  const r = pageRig({ perks: closed });
  const b = r.document.createElement('button');
  r.P.mark(b, 'allScreens');
  assert.ok(b.classList.contains('is-perk'));
  assert.equal(b.querySelector('.bit-perk-heart')?.tagName, 'SVG');
  assert.equal(b.getAttribute('aria-description'), 'mybit_perk_supporters');
  assert.equal(r.P.keys(), 4);
  const open = pageRig({ perks: { allScreens: { access: 'supporter', open: true }, moreKeys: { access: 'free', open: true } } });
  const c = open.document.createElement('button');
  open.P.mark(c, 'allScreens');
  assert.equal(c.children.length, 0);
  assert.equal(open.P.keys(), 8);
  assert.equal(pageRig().P.keys(), 8, 'an older server with no extras: as free');
});

test('the page: with a pass the hub is asked, then the choice again; without one, or on a no, the support sheet', async () => {
  let again = 0;
  const r = pageRig();
  r.P.offer('allScreens', () => { again++; });
  await settle(30);
  assert.deepEqual(r.posts, [{ url: '/api/bit/perk', body: { perk: 'allScreens' } }]);
  assert.equal(again, 1);
  assert.deepEqual(r.sheets, []);
  const noPass = pageRig({ saved: false });
  noPass.P.offer('moreKeys', () => { again++; });
  await settle(30);
  assert.deepEqual(noPass.posts, [], 'no pass: nothing asked');
  assert.deepEqual(noPass.sheets, ['bit-morekeys']);
  const no = pageRig({ answer: { ok: false, error: 'expired' } });
  no.P.offer('allScreens');
  await settle(30);
  assert.deepEqual(no.sheets, ['bit-allscreens']);
  const phone = pageRig({ remote: true });
  phone.P.offer('allScreens');
  await settle(30);
  assert.deepEqual(phone.posts, [], 'a phone never uses the pass');
  assert.deepEqual(phone.sheets, ['bit-allscreens']);
  const offline = pageRig({ answer: { ok: false, error: 'network' } });
  offline.P.offer('allScreens');
  await settle(30);
  assert.deepEqual(offline.toasts, ['mybit_save_failed']);
  assert.deepEqual(offline.sheets, [], 'offline is not a reason to sell');
  assert.equal(again, 1);
});
