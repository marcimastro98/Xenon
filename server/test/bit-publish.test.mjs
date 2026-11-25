// The person's own Bit on xenon-app.com (server/bit/publish.js): shown only by their choice,
// what goes to the hub, and what happens when the hub says no. Every seed, number and name
// here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Model = require('../bit/model.js');
const { createBitStore } = require('../bit/store.js');
const { createHatch } = require('../bit/hatch.js');
const { createPublish, PUBLISH_PATH } = require('../bit/publish.js');
const { createRoutes } = require('../bit/handlers.js');

const SEED = '0123456789abcdef';
const ID = 'b'.repeat(64);
const born = { ok: true, seed: SEED, number: 1284, born: '2026-12-03T11:00:00.000Z', sig: 'made-up' };

async function harness(t, { local = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-bit-pub-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createBitStore({ dataDir: dir });
  await store.create(false);
  const sent = [];
  let answer = { ok: true };
  const post = async (path, body) => {
    if (path !== PUBLISH_PATH) return local ? null : born;
    sent.push(body);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const hatch = createHatch({ store, scopedId: async () => ID, post, now: () => (local ? new Date(Date.now() + 4 * 86400000) : new Date()) });
  const publish = createPublish({ store, scopedId: async () => ID, post });
  const told = [];
  const routes = createRoutes({ store, hatch, founder: async () => false, publish, changed: (b) => told.push(b) });
  const call = async (key, body) => {
    const out = [];
    const ctx = { json: (v) => out.push(v), readBody: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? {})) };
    await routes[key]({}, {}, ctx, {});
    return out[0];
  };
  await call('POST /api/bit/hatch');
  return { call, store, sent, told, answer: (a) => { answer = a; } };
}

test('shown by choice: the hub hears the name, outfit and stage, and the view gets its page', async (t) => {
  const h = await harness(t);
  await h.call('POST /api/bit/name', { name: 'Pixel' });
  assert.equal(h.sent.length, 0, 'nothing goes while it is not shown');
  const r = await h.call('POST /api/bit/publish', { public: true });
  assert.equal(r.ok, true);
  assert.equal(r.bit.shown, true);
  assert.equal(r.bit.page, 'https://xenon-app.com/bit.html#1284');
  const [body] = h.sent;
  assert.deepEqual(Object.keys(body).sort(), ['name', 'public', 'scopedId', 'stage', 'worn']);
  assert.deepEqual([body.scopedId, body.public, body.name, body.stage], [ID, true, 'Pixel', 'baby']);
  assert.ok(Array.isArray(body.worn));
  const off = await h.call('POST /api/bit/publish', { public: false });
  assert.equal(off.bit.shown, false);
  assert.equal(off.bit.page, '');
  assert.deepEqual(h.sent[1], { scopedId: ID, public: false }, 'taking it down sends nothing else');
});

test('while shown, a new name goes to the hub too', async (t) => {
  const h = await harness(t);
  await h.call('POST /api/bit/publish', { public: true });
  await h.call('POST /api/bit/name', { name: 'Nova' });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.sent.at(-1).name, 'Nova');
  await h.call('POST /api/bit/prefs', { reactions: 'few' });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.sent.length, 2, 'a change the page does not show sends nothing');
});

test('a refresh says it is one, and comes after a choice made before it, bursts as one', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-bit-pub-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createBitStore({ dataDir: dir });
  await store.create(false);
  await store.update((m) => ({ model: { ...m, bit: { seed: SEED, number: 1284, born: born.born, sig: 'x', local: false } } }));
  const sent = [];
  const held = [];
  const post = (_path, body) => new Promise((resolve) => { sent.push(body); held.push(() => resolve({ ok: true })); });
  const publish = createPublish({ store, scopedId: async () => ID, post });
  const tick = () => new Promise((r) => setImmediate(r));

  const on = publish.set(true);
  await tick();
  const first = publish.refresh();
  for (let i = 0; i < 5; i++) assert.equal(publish.refresh(), first, 'one refresh waits for its turn, the rest join it');
  const off = publish.set(false);
  assert.equal(sent.length, 1, 'one call out at a time');
  held.shift()();
  assert.deepEqual(await on, { ok: true });
  await tick();
  assert.equal(sent[1].refresh, true);
  held.shift()();
  await first;
  await tick();
  assert.deepEqual(sent[2], { scopedId: ID, public: false }, 'the hide goes last, as it was asked last');
  held.shift()();
  assert.deepEqual(await off, { ok: true });
  assert.equal(store.peek().shown, false);
  assert.equal(await publish.refresh(), false, 'a hidden Bit sends no refresh');
  assert.equal(sent.length, 3);
});

test('the hub has it hidden: a refresh stops showing it here too', async (t) => {
  const h = await harness(t);
  await h.call('POST /api/bit/publish', { public: true });
  h.answer({ ok: false, error: 'not_shown' });
  await h.call('POST /api/bit/name', { name: 'Late' });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(h.sent.at(-1).refresh, true);
  assert.equal(Model.view(await h.store.ready(), new Date()).shown, false);
});

test('the hub says no: the choice is not kept, and a Bit taken down stops being shown', async (t) => {
  const h = await harness(t);
  h.answer(new Error('offline'));
  const r = await h.call('POST /api/bit/publish', { public: true });
  assert.deepEqual([r.ok, r.error, r.bit.shown], [false, 'network', false]);
  h.answer({ ok: true });
  await h.call('POST /api/bit/publish', { public: true });
  h.answer({ ok: false, error: 'taken_down' });
  await h.call('POST /api/bit/name', { name: 'Again' });
  await new Promise((r2) => setImmediate(r2));
  await new Promise((r2) => setImmediate(r2));
  assert.equal(Model.view(await h.store.ready(), new Date()).shown, false);
  const again = await h.call('POST /api/bit/publish', { public: true });
  assert.deepEqual([again.ok, again.error], [false, 'taken_down']);
});

test('only a Bit with the hub\'s number has a page, and the body must say yes or no', async (t) => {
  const h = await harness(t, { local: true });
  const v = Model.view(await h.store.ready(), new Date());
  assert.equal(v.local, true);
  assert.equal((await h.call('POST /api/bit/publish', { public: true })).error, 'no_number');
  assert.equal(h.sent.length, 0);
  assert.equal((await h.call('POST /api/bit/publish', { public: 'yes' })).error, 'bad_request');
  assert.equal((await h.call('POST /api/bit/publish', '{oops')).error, 'bad_request');
});

test('the choice is kept in the file, and a file that says shown with no number shows no page', () => {
  const m = Model.normalize({ bit: { seed: SEED, number: 7, born: born.born, sig: 'x' }, shown: true });
  assert.equal(m.shown, true);
  assert.equal(Model.normalize({ shown: 'yes' }).shown, false);
  const local = Model.normalize({ bit: { seed: SEED, number: null, born: born.born, sig: '', local: true }, shown: true });
  assert.equal(Model.view(local, new Date()).page, '');
  assert.equal(Model.setShown(local, true).error, 'no_number');
});
