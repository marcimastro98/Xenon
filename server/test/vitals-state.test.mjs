// The Vitals state saved from a layer page (server/vitals-state.js, POST
// /api/vitals/state): a refill or a truce tapped on a widget on the screen is
// kept, merged like the dashboard's save, and the door takes nothing but state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const V = require('../vitals-state.js');
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('the merge never rewinds: newest refill, highest XP, the later day', () => {
  const prev = { last: { hydration: 2000, energy: 500 }, xp: 40, day: '2026-10-30', fills: 3, log: ['a', 'b', 'c'], awayCreditAt: 900 };
  const stale = { last: { hydration: 1000, energy: 800 }, xp: 10, day: '2026-10-29', fills: 9, log: ['x'], awayCreditAt: 100 };
  const out = V.mergeState(prev, stale);
  assert.deepEqual(out.last, { hydration: 2000, energy: 800 });
  assert.equal(out.xp, 40);
  assert.equal(out.day, '2026-10-30');
  assert.equal(out.fills, 3);
  assert.deepEqual(out.log, ['a', 'b', 'c']);
  assert.equal(out.awayCreditAt, 900);
  const sameDay = V.mergeState(prev, { ...prev, fills: 1, log: ['a'] });
  assert.equal(sameDay.fills, 3, 'the same day keeps the higher count');
  assert.deepEqual(sameDay.log, ['a', 'b', 'c'], 'and the longer ribbon');
});

test("Bit's truce and memory merge, never last-writer-wins", () => {
  const prev = { pet: { snoozeUntil: 5000, muteDay: '', ep: {} }, mem: { streak: 4, bestStreak: 9, locksTotal: 3 } };
  const out = V.mergeState(prev, { pet: { snoozeUntil: 0, muteDay: '', ep: {} }, mem: { streak: 4, bestStreak: 2, locksTotal: 1 } });
  assert.equal(out.pet.snoozeUntil, 5000, 'a truce granted elsewhere holds');
  assert.equal(out.mem.bestStreak, 9);
  assert.equal(out.mem.locksTotal, 3);
});

test('the layer door takes only state keys', () => {
  assert.deepEqual(V.plan({ state: { last: { hydration: 1 } } }), { state: { last: { hydration: 1 } } });
  assert.equal(V.plan({}).error, 'bad_state');
  assert.equal(V.plan({ state: [] }).error, 'bad_state');
  assert.deepEqual(V.plan({ state: { pet: {}, items: {} } }), { error: 'not_allowed', field: 'items' });
  assert.equal(V.plan({ state: { log: ['x'.repeat(40 * 1024)] } }).error, 'too_large');
});

function helper({ layer, fetchOk = true }) {
  const calls = { saved: 0, posts: [], warned: 0 };
  const ctx = {
    window: { location: { search: layer ? '?layer=overlay:' : '' } },
    document: {}, console: { warn() { calls.warned++; } }, JSON,
    SERVER: 'http://127.0.0.1:3030',
    hubSettings: { vitals: { enabled: true, state: { last: { hydration: 1234 }, xp: 5 } } },
    saveHubSettings: () => { calls.saved++; },
    fetch: async (url, opts) => { calls.posts.push([url, JSON.parse(opts.body)]); return { ok: fetchOk, status: fetchOk ? 200 : 400 }; },
  };
  vm.createContext(ctx);
  vm.runInContext(read('js/utils.js'), ctx);
  return { ctx, calls };
}

test('the dashboard saves the settings; a layer page posts only vitals.state', async () => {
  const dash = helper({ layer: false });
  vm.runInContext('saveVitalsStateNow()', dash.ctx);
  assert.equal(dash.calls.saved, 1);
  assert.equal(dash.calls.posts.length, 0);
  const lay = helper({ layer: true });
  vm.runInContext('saveVitalsStateNow()', lay.ctx);
  await new Promise((r) => setImmediate(r));
  assert.equal(lay.calls.saved, 0, 'never the whole blob from a layer page');
  assert.deepEqual(JSON.parse(JSON.stringify(lay.calls.posts)), [['http://127.0.0.1:3030/api/vitals/state', { state: { last: { hydration: 1234 }, xp: 5 } }]]);
  const refused = helper({ layer: true, fetchOk: false });
  vm.runInContext('saveVitalsStateNow()', refused.ctx);
  await new Promise((r) => setImmediate(r));
  assert.equal(refused.calls.warned, 1, 'a refused save is said, not swallowed');
});

test('wiring: both widgets save through the helper, one merge on both doors, the lock, the door lists', () => {
  assert.match(read('js/vitals.js'), /function saveState\(patch\) \{[\s\S]{0,250}saveVitalsStateNow\(\);/);
  assert.match(read('js/vitals-pet.js'), /function saveVitalsState\(patch\) \{[\s\S]{0,400}saveVitalsStateNow\(\);/);
  const S = engineSource();
  assert.match(S, /incoming\.vitals = \{ \.\.\.inV, state: VitalsState\.mergeState\(prev\.vitals\.state, inV\.state\) \};/);
  assert.match(S, /reqPath === '\/api\/vitals\/state' && req\.method === 'POST'[\s\S]{0,300}saveVitalsState\(body\)/);
  assert.match(S, /async function saveVitalsState\(body\) \{[\s\S]{0,200}withHubSettingsLock[\s\S]{0,400}VitalsState\.mergeState\(vitals\.state, plan\.state\)[\s\S]{0,200}nextSettingsRev[\s\S]{0,200}broadcastSSE\('settings'/);
  assert.match(S, /const CSRF_MUTATION_PATHS = new Set\(\[[\s\S]{0,300}'\/api\/vitals\/state',/);
  assert.match(read('remote-access.js'), /'\/settings\/tile',\n[^\n]*\n  '\/api\/vitals\/state',/);
});
