// The Bit's shop in the Store (js/bit-companion/shelf.js): each item a picture of the person's own
// Bit wearing it, with its price; a tap tries it on the big Bit for free and opens the same keep step
// as the sheet; an owned item goes on or off; an egg is sent to its sheet. The Store's rail row and
// the Sparks view's card lead here. Every seed here is made up.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { makeDom, settle } from './mini-dom.mjs';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const BIT_ENGINE = require('./fixtures/bit-engine.json');
const src = (p) => readFileSync(join(SERVER, p), 'utf8');
const FILES = [...BIT_ENGINE, 'js/ai/bit-app.js', 'js/bit-companion/wardrobe-keep.js', 'js/bit-companion/wardrobe.js', 'js/bit-companion/shelf.js'];
const SEED = '0123456789abcdef';
const born = (more = {}) => ({
  ok: true, hatched: true, stage: 'baby', founder: false, everywhere: true, reactionsPerHour: 6,
  prefs: { place: 'corner', reactions: 'normal', sounds: false, classic: false },
  seed: SEED, number: 1284, local: false, born: '2026-11-24T20:00:00.000Z', name: '', worn: ['cap'], owned: ['cap'], days: 3, traits: [], ...more,
});

function rig({ answers = {} } = {}) {
  const { document } = makeDom();
  const posts = [];
  const winHandlers = {};
  const ctx = {
    console, Math, Promise, queueMicrotask, Object, Array, String, Number, Set, Map, JSON, RegExp, Date, AbortController,
    document,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    addEventListener: (type, fn, opts) => {
      (winHandlers[type] ||= []).push(fn);
      opts?.signal?.addEventListener?.('abort', () => { winHandlers[type] = winHandlers[type].filter((f) => f !== fn); });
    },
    removeEventListener() {},
    dispatchEvent: (e) => { (winHandlers[e.type] || []).forEach((fn) => fn(e)); return true; },
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    t: (key) => key,
    lang: 'en',
    SERVER: '',
    makeEl: (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    },
    fetch: async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      if (body !== undefined) posts.push({ url, body });
      const answer = answers[url];
      const out = typeof answer === 'function' ? answer(body) : answer || { ok: false, error: 'offline' };
      return { json: async () => out };
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of FILES) vm.runInContext(src(f), ctx, { filename: f });
  const view = document.createElement('div');
  document.body.append(view);
  const closed = [];
  const open = () => ctx.BitShelf.render(view, { close: () => closed.push(true) });
  const card = (id) => view.querySelectorAll('.bshelf-card').find((b) => b.querySelector('.bshelf-name').textContent === `mybit_item_${id}`);
  return { ctx, view, posts, closed, open, card, tell: (bit) => ctx.BitApp.heard(bit) };
}

test('the shop and the supporters\' items, each the person\'s own Bit wearing it, priced or marked as its own', (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-25T12:00:00Z') });
  const r = rig();
  r.tell(born({ owned: ['cap', 'guitar'] }));
  r.open();
  const shelves = r.view.querySelectorAll('.bshelf-group');
  assert.deepEqual(shelves.map((g) => g.dataset.source), ['shop', 'supporter']);
  assert.deepEqual(shelves.map((g) => g.querySelector('.bshelf-group-title').textContent), ['mybit_group_shop', 'mybit_group_supporter']);
  assert.equal(shelves[0].querySelector('.bshelf-group-line'), null, 'the shop does not point to the Store from inside it');
  assert.equal(shelves[1].querySelector('.bshelf-group-line').textContent, 'mybit_group_supporter_line');

  const beanie = r.card('beanie');
  assert.ok(beanie.querySelector('.bshelf-art svg rect'), "drawn cell by cell in this Bit's colours");
  assert.equal(beanie.querySelector('.bitw-item-price').textContent, '50');
  assert.equal(beanie.getAttribute('aria-label'), 'mybit_item_beanie, gallery_sparks_price');
  const guitar = r.card('guitar');
  assert.equal(guitar.querySelector('.bshelf-owned').textContent, 'mybit_shelf_owned');
  assert.equal(guitar.querySelector('.bitw-item-price'), null, 'its own: no price');
  assert.ok(r.card('crown') && !r.card('wings'), "this month's supporter item and the next, never further ahead");
  const prices = shelves[0].querySelectorAll('.bitw-item-price').map((p) => Number(p.textContent));
  assert.ok(prices.every((n, i) => !i || n >= prices[i - 1]), 'cheapest first');
  assert.ok(r.view.querySelector('.bshelf-stage .bshelf-bit'), 'the big Bit on top');
});

test('a tap tries it on for free, with the keep step of the sheet; again takes it off', () => {
  const r = rig();
  r.tell(born());
  r.open();
  r.card('beanie').click();
  assert.equal(r.posts.length, 0, 'trying on asks nothing');
  assert.equal(r.card('beanie').getAttribute('aria-pressed'), 'true');
  const box = r.view.querySelector('.bshelf-slot .bitw-detail');
  assert.equal(box.querySelector('.bitw-detail-title').textContent, 'mybit_trying');
  assert.equal(box.querySelector('.bitw-detail-line').textContent, 'mybit_shop_line');
  assert.ok(box.querySelector('.bitw-detail-actions'), 'the buy step of the sheet');
  r.card('beanie').click();
  assert.equal(r.view.querySelector('.bshelf-slot .bitw-detail'), null);
  assert.equal(r.card('beanie').getAttribute('aria-pressed'), 'false');
});

test('an item it owns goes on and off at once, and a no from the server is said', async () => {
  const r = rig({ answers: { '/api/bit/wear': (body) => ({ ok: true, bit: born({ owned: ['cap', 'guitar'], worn: body.worn }) }) } });
  r.tell(born({ owned: ['cap', 'guitar'] }));
  r.open();
  r.card('guitar').click();
  await settle();
  assert.deepEqual(r.posts.at(-1), { url: '/api/bit/wear', body: { worn: ['cap', 'guitar'] } });
  assert.equal(r.card('guitar').getAttribute('aria-pressed'), 'true', 'the answer redraws the shelf');
  r.card('guitar').click();
  await settle();
  assert.deepEqual(r.posts.at(-1).body, { worn: ['cap'] });

  const off = rig();
  off.tell(born({ owned: ['cap', 'guitar'] }));
  off.open();
  off.card('guitar').click();
  await settle();
  assert.equal(off.view.querySelector('.bshelf-note').textContent, 'mybit_save_failed');
});

test('an egg is sent to its sheet; with no Bit known yet the shelf says it cannot open', () => {
  const r = rig();
  r.tell({ ...born(), hatched: false, stage: 'egg' });
  let opened = 0;
  r.ctx.BitSheet = { open: () => { opened += 1; } };
  r.open();
  assert.equal(r.view.querySelector('.bshelf-line').textContent, 'mybit_shelf_egg');
  assert.equal(r.view.querySelector('.bshelf-card'), null);
  r.view.querySelector('.bshelf-wait button').click();
  assert.deepEqual([r.closed.length, opened], [1, 1], 'the Store closes and the sheet opens');

  const none = rig();
  none.open();
  assert.equal(none.view.querySelector('.bshelf-line').textContent, 'mybit_keep_unavailable');
  assert.equal(none.view.querySelector('.bshelf-wait button'), null);
});

test('the Store lists the shelf on its rail and the Sparks view sends there', () => {
  const gallery = src('js/community-gallery/community-gallery.js');
  assert.match(gallery, /railRow\('__bit', t\('mybit_title'/);
  assert.match(gallery, /__bit: window\.BitShelf && 'bit'/);
  assert.match(gallery, /window\.BitShelf\.render\(viewEl, \{ close \}\)/);
  assert.match(gallery, /SparksStore\.render\(viewEl, \{[^}]*goView \}\)/);
  const sparks = src('js/store-supporters/sparks-store.js');
  assert.match(sparks, /ctx\.goView\('__bit'\)/);
  const page = src('index.html');
  assert.ok(page.indexOf('js/bit-companion/wardrobe.js') < page.indexOf('js/bit-companion/shelf.js'), 'after the wardrobe it draws with');
});
