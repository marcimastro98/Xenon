// The pump's screen runs in a browser of its own (pump-screen/direct-browser.js): elsewhere.js reads
// there, from the live stream, what Bit does at rest and the signs it holds, so the SDK `bit` stream
// says on the pump what it says on the dashboard, and the kit plays it. Every session here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync as readDisk } from 'node:fs';
import { readFileSync } from './browser-source.mjs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const bitSigns = require('../../packages/core/src/bit-signs.js');
const { bitKit } = require('../bit/kit.js');
const Model = require('../bit/model.js');

const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// A page with elsewhere.js and signals.js on a stream we drive.
function pumpPage() {
  const store = new Map();
  const window = {
    Xenon: { bitSigns },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
  };
  Object.assign(window, { window, dispatchEvent() {}, addEventListener() {}, CustomEvent: class { constructor(t) { this.type = t; } }, setTimeout: () => 0, clearTimeout() {} });
  vm.createContext(window);
  for (const f of ['../js/bit-companion/signals.js', '../js/bit-companion/elsewhere.js', '../js/custom-widget/stream-readers.js']) vm.runInContext(src(f), window);
  const fns = new Map();
  window.BitElsewhere.listen({ addEventListener: (name, fn) => fns.set(name, fn) });
  const send = (name, d) => fns.get(name)?.({ data: JSON.stringify(d) });
  return { window, send, fns };
}
const sessions = (...states) => ({ live: { sessions: states.map((state, i) => ({ id: `s${i}`, state })) } });

test('elsewhere: at its computer while a session works, gaming while a game runs, waiting there with news after', () => {
  const { window: w, send } = pumpPage();
  const B = w.BitElsewhere;
  assert.equal(B.rest(), 'idle');
  send('claude', sessions('running', 'idle'));
  assert.equal(B.rest(), 'code');
  send('status', { gaming: true });
  assert.equal(B.rest(), 'gamer', 'a game wins over the desk, as on the dashboard');
  send('status', { gaming: false });
  send('claude', { live: { sessions: [{ id: 's0', state: 'running', waitFor: 'permission' }] } });
  assert.equal(B.rest(), 'tell', 'a session waiting for the person is not working: Bit waits to tell it');
  send('codex', sessions('running'));
  assert.equal(B.rest(), 'code');
  send('codex', sessions('idle'));
  send('claude', { not: 'sessions' });
  assert.equal(B.rest(), 'tell', 'an event without sessions changes nothing; a finished session is news');
  send('claude', sessions('idle'));
  w.BitSignals.seen();
  assert.equal(B.rest(), 'idle', 'no longer asking, and seen: it gets up');
});

test('elsewhere: the signs come from the same events, and a move asked elsewhere reaches the widget', () => {
  const { window: w, send } = pumpPage();
  send('claude', sessions('running'));
  send('claude', sessions('idle'));
  assert.equal(w.BitSignals.top()?.kind, 'done', 'the sign of a finished session');
  send('bit_play', { clip: 'dance' });
  send('bit_play', { clip: '<b>' });
  const out = w.CustomWidgetStreamReaders.bit({ ok: true, bit: { ok: false } }, null, null, null);
  assert.equal(out.ok, false);
  assert.equal(w.BitElsewhere.lastPlayed().clip, 'dance', 'a name that is not a clip id is dropped');
});

test('reader: doing is one of the rests or null', () => {
  const { window: w } = pumpPage();
  const egg = Model.normalize({ eggAt: '2026-01-01T00:00:00.000Z' });
  const NOW = new Date(2026, 11, 3, 12);
  const view = Model.view(Model.hatched(egg, { seed: '0123456789abcdef', number: 7, born: NOW.toISOString(), sig: 'made-up' }, NOW).model, NOW);
  const read = (doing) => w.CustomWidgetStreamReaders.bit({ ok: true, bit: view }, null, null, doing).doing;
  assert.equal(read('code'), 'code');
  assert.equal(read('gamer'), 'gamer');
  assert.equal(read('idle'), 'idle');
  assert.equal(read('dance'), null);
  assert.equal(read(undefined), null, 'a page that does not know says nothing');
});

test('the pump page loads the signs, signals and elsewhere before the bridge, and hands them its stream', () => {
  const html = readDisk(new URL('../pump-widget.html', import.meta.url), 'utf8');
  const at = ['shared/src/bit-signs.js', 'js/bit-companion/signals.js', 'js/bit-companion/elsewhere.js', 'js/custom-widget/custom-widget.js'].map((f) => html.indexOf(`src="${f}"`));
  assert.ok(at.every((n) => n > 0) && at.every((n, i) => !i || n > at[i - 1]), String(at));
  assert.match(src('../js/pump/pump-widget-host.js'), /WidgetFeed\.listen\(es, widgets\);\s+window\.BitElsewhere\?\.listen\(es\);/);
});

test('kit: Bit sits at its computer or games as data.doing says, and a move of its own is left alone', async () => {
  const el = () => ({ setAttribute() {}, removeAttribute() {}, appendChild: (c) => c, append() {}, remove() {}, replaceChildren() {}, insertBefore() {}, querySelector: () => null, style: {}, classList: { add() {}, remove() {}, toggle() {} }, children: [] });
  const ctx = {
    document: { createElementNS: el, createElement: el, addEventListener() {}, removeEventListener() {}, hidden: false },
    setTimeout, clearTimeout, performance, requestAnimationFrame: (f) => setTimeout(f, 16), cancelAnimationFrame: clearTimeout,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  new vm.Script(await bitKit()).runInContext(ctx);
  let player = null;
  const real = ctx.Xenon.bitPlayer.mount;
  ctx.Xenon.bitPlayer.mount = (host, opts) => (player = real(host, opts));
  const { window: w } = pumpPage();
  const egg = Model.normalize({ eggAt: '2026-01-01T00:00:00.000Z' });
  const NOW = new Date(2026, 11, 3, 12);
  const view = Model.view(Model.hatched(egg, { seed: '0123456789abcdef', number: 7, born: NOW.toISOString(), sig: 'made-up' }, NOW).model, NOW);
  const data = (doing) => JSON.parse(JSON.stringify(w.CustomWidgetStreamReaders.bit({ ok: true, bit: view }, null, null, doing)));
  const b = ctx.XenonBit.mount(el(), { label: 'Bit' });
  b.set(data('idle'));
  assert.equal(player.mood, 'idle');
  b.set(data('code'));
  assert.equal(player.mood, 'code', 'the kit carries the desk loops');
  b.set(data('gamer'));
  assert.equal(player.mood, 'gamer');
  b.set(data(null));
  assert.equal(player.mood, 'gamer', 'a page that does not know leaves it be');
  player.setMood('sleep');
  b.set(data('code'));
  assert.equal(player.mood, 'sleep', 'a mood the widget set is its own');
  b.destroy();
});
