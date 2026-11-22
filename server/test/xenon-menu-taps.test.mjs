// "I tap the keys and they react late, a while after": in the Xenon menu (js/menu/xenon-menu.js)
// a choice lights the moment it is tapped, and the menu takes no other tap until the rows are
// drawn again after the change. A tap before that came from the rows drawn before it, so it
// sent what they knew: two quick taps on the readings and the second undid the first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeDom } from './mini-dom.mjs';

const View = createRequire(import.meta.url)('../js/menu/xenon-menu.js');

// A request that answers only when the test says so.
function later() {
  let done;
  const p = new Promise((r) => { done = r; });
  return { p, done };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function rig() {
  const { document } = makeDom();
  const root = document.createElement('div');
  document.body.append(root);
  const posts = [];
  const gets = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, o = {}) => {
    const wait = later();
    (o.method === 'POST' ? posts : gets).push({ url, body: o.body && JSON.parse(o.body), answer: (v) => wait.done({ ok: true, json: async () => v }) });
    return wait.p;
  };
  const view = View.create(root, { t: (k) => k, bare: true });
  const chips = () => root.querySelectorAll('.xm-choice');
  const chip = (value) => chips().find((b) => b.dataset.keep.endsWith(':' + value));
  return { root, view, posts, gets, chip, chips, restore: () => { globalThis.fetch = realFetch; view.destroy(); } };
}

const option = (value, on, rank) => ({ value, label: { text: value }, on, rank, act: { run: { type: 'pumpSet', value } } });
const state = (rows) => ({ sections: [{ id: 'screens', title: { text: 'Screens' }, sub: { text: '' }, rows }] });
const readings = (on) => ({
  kind: 'choice', id: 'r', multi: true, label: { text: 'Readings' },
  options: ['cpu', 'gpu', 'fps'].map((v) => option(v, on.includes(v), on.indexOf(v) + 1)),
});

test('a reading lights at once, its place shows once the rows come back, and no tap goes on old rows', async (t) => {
  const r = rig();
  t.after(r.restore);
  const loading = r.view.load();
  r.gets.shift().answer(state([readings(['gpu'])]));
  await loading;
  assert.deepEqual(r.chips().map((b) => [b.dataset.keep, b.getAttribute('aria-pressed'), b.dataset.rank]),
    [['r:cpu', 'false', undefined], ['r:gpu', 'true', '1'], ['r:fps', 'false', undefined]], 'every key in its place, the one on says its place');

  r.chip('fps').click();
  assert.equal(r.chip('fps').getAttribute('aria-pressed'), 'true', 'lit before any answer');
  assert.equal(r.chip('fps').dataset.rank, undefined, 'its place comes with the rows');
  assert.equal(r.posts.length, 1);
  assert.ok(r.root.classList.contains('is-busy'));

  r.chip('cpu').click();
  assert.equal(r.chip('cpu').getAttribute('aria-pressed'), 'false', 'a tap while the last one is on its way does nothing');
  assert.equal(r.posts.length, 1);

  r.posts[0].answer({ ok: true });
  await tick();
  assert.equal(r.gets.length, 1, 'the menu reads itself again');
  r.chip('cpu').click();
  assert.equal(r.posts.length, 1, 'still nothing: these rows were drawn before the change');

  r.gets.shift().answer(state([readings(['gpu', 'fps'])]));
  await tick();
  await tick();
  assert.equal(r.root.classList.contains('is-busy'), false);
  assert.deepEqual([r.chip('gpu').dataset.rank, r.chip('fps').dataset.rank], ['1', '2']);
  r.chip('cpu').click();
  assert.deepEqual(r.posts.map((p) => p.body.value), ['fps', 'cpu'], 'drawn again: the next tap goes');
});

test('one answer of several: the tapped one lights and the others go out at once', async (t) => {
  const r = rig();
  t.after(r.restore);
  const loading = r.view.load();
  const dim = { kind: 'choice', id: 'd', label: { text: 'Dim' }, value: 100, options: [100, 50].map((v) => ({ value: v, label: { text: String(v) }, act: { run: { type: 'pumpSet', v } } })) };
  r.gets.shift().answer(state([dim]));
  await loading;
  r.chip('50').click();
  assert.deepEqual(r.chips().map((b) => b.getAttribute('aria-pressed')), ['false', 'true']);
  r.chip('100').click();
  assert.deepEqual(r.chips().map((b) => b.getAttribute('aria-pressed')), ['false', 'true'], 'busy: the old rows do not answer');
  assert.equal(r.posts.length, 1);
});
