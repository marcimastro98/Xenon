// The Bit's room in the Store (js/bit-companion/room.js, mode 'store'): the same stage as its sheet,
// filling the Store's "Your Bit" view, with no close of its own; each item the person's own Bit
// wearing it, with its price; a tap tries it on for free with the same keep step; an owned item goes
// on or off; an egg hatches right there. The Store's rail row and the Sparks view's card lead here.
// Every seed here is made up.
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
const ROOM = ['wardrobe-keep', 'wardrobe-tabs', 'wardrobe', 'card-dna', 'card', 'recap', 'clip', 'room-scenery', 'room-panels', 'room', 'store-band'];
const FILES = [...BIT_ENGINE, 'js/ai/bit-app.js', ...ROOM.map((f) => `js/bit-companion/${f}.js`)];
// The supporters' items come with the view, as the hub made them (server/bit/items.js).
const HUB_ITEMS = require('./fixtures/bit-hub-items.json').map((it) => ({ ...it, offered: true }));
const SEED = '0123456789abcdef';
const born = (more = {}) => ({
  ok: true, hatched: true, stage: 'baby', founder: false, everywhere: true, reactionsPerHour: 6,
  prefs: { place: 'corner', reactions: 'normal', sounds: false, classic: false },
  seed: SEED, number: 1284, local: false, born: '2026-11-24T20:00:00.000Z', name: '', worn: ['cap'], owned: ['cap'], days: 3, traits: [], items: HUB_ITEMS, ...more,
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
  const open = () => ctx.BitRoom.store(view);
  const card = (id) => view.querySelector(`.broom-card[data-item="${id}"]`);
  const tab = (id) => view.querySelector(`.broom-tab[data-tab="${id}"]`);
  const lines = () => view.querySelectorAll('.broom-keep-line').map((p) => p.textContent);
  return { ctx, view, posts, open, card, tab, lines, winHandlers, tell: (bit) => ctx.BitApp.heard(bit) };
}

test("the Store's view is the Bit's room: its own items first, the shop priced, this month's and the next supporter item", (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-25T12:00:00Z') });
  const r = rig();
  r.tell(born({ owned: ['cap', 'guitar'] }));
  const room = r.open();
  assert.ok(room, 'a room');
  assert.ok(r.view.querySelector('.broom.is-store .broom-stage .broom-bit'), 'the big Bit on its stage');
  assert.equal(r.view.querySelector('.broom-tools').children.length, 1, 'its settings, and no close: the Store has its own');

  const beanie = r.card('beanie');
  assert.ok(beanie.querySelector('.broom-card-art svg rect'), "drawn cell by cell in this Bit's colours");
  assert.equal(beanie.querySelector('.broom-price').textContent, '50');
  assert.equal(beanie.getAttribute('aria-label'), 'mybit_item_beanie, gallery_sparks_price');
  const guitar = r.card('guitar');
  assert.equal(guitar.dataset.source, 'mine');
  assert.equal(guitar.querySelector('.broom-tag').textContent, 'mybit_shelf_owned');
  assert.equal(guitar.querySelector('.broom-price'), null, 'its own: no price');
  const prices = r.view.querySelectorAll('.broom-card[data-source="shop"] .broom-price').map((p) => Number(p.textContent));
  assert.ok(prices.every((n, i) => !i || n >= prices[i - 1]), 'cheapest first');
  r.tab('supporter').click();
  assert.ok(r.card('crown') && !r.card('cape') && !r.card('wings'), "the next supporter item, never further ahead");
});

test("supporters' items have their own tab, with the Store's heart; the one still to come is blurred and can't be tried", (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-12-10T12:00:00Z') });
  const r = rig();
  r.tell(born());
  r.ctx.t = (key) => (key === 'mybit_soon_from' ? 'From {date}' : key);
  r.open();
  assert.equal(r.view.querySelector('.broom-card[data-source="supporter"]'), null, 'not mixed in with everything');
  const tab = r.tab('supporter');
  assert.ok(tab.classList.contains('is-supporter') && tab.querySelector('svg rect'), 'a tab of their own, the heart in pixels');
  assert.equal(tab.querySelector('.broom-tab-word').textContent, 'mybit_group_supporter');
  tab.click();
  const cards = r.view.querySelector('.broom-items').children;
  assert.ok(cards[0].tagName === 'P' && cards[0].classList.contains('broom-intro'), 'it opens with what they are');
  assert.equal(cards[0].textContent, 'mybit_group_supportermybit_group_supporter_line');
  assert.ok(cards.slice(1).every((c) => c.dataset.source === 'supporter'), 'only theirs');
  const crown = r.card('crown');
  const cape = r.card('cape');
  assert.ok(crown.classList.contains('is-supporter') && !crown.classList.contains('is-soon'), "December's crown is out");
  assert.ok(crown.querySelector('.broom-tag.is-supporter svg path'), 'the heart');
  assert.equal(crown.querySelector('.broom-tag').textContent, 'mybit_group_supporter');
  assert.ok(cape.classList.contains('is-supporter') && cape.classList.contains('is-soon'), "January's cape is the preview");
  assert.equal(cape.querySelector('.broom-tag').textContent, 'From Jan 1', 'the short month: the long one does not fit under a card');
  assert.match(cape.getAttribute('aria-label'), /From Jan 1/, 'said too, not only blurred');
  assert.equal(cape.getAttribute('aria-disabled'), 'true');
  cape.click();
  assert.equal(r.ctx.BitWardrobe.tried().length, 0, "next month's is only shown");
  assert.equal(cape.getAttribute('aria-pressed'), 'false');
  crown.click();
  assert.deepEqual(Array.from(r.ctx.BitWardrobe.tried(), (it) => it.id), ['crown'], "this month's is tried on");
  r.tab('all').click();
  assert.ok(!r.card('beanie').classList.contains('is-supporter'), 'a shop item stays plain');
  r.card('beanie').click();
  assert.deepEqual(Array.from(r.ctx.BitWardrobe.tried(), (it) => it.id), ['beanie'], 'it comes another way: tried alone');
  const css = src('components/BitCompanion/BitCompanion.css');
  assert.match(css, /\.broom-card\.is-soon \.broom-card-art svg \{ filter: blur\(/);
  assert.match(css, /\.broom-card\.is-supporter \{ background: var\(--broom-brass\); color: var\(--broom-wall\); \}/);
  assert.match(css, /\.broom-card\[aria-disabled='true'\] \{ cursor: default; \}/);
  assert.match(css, /\.broom-card\.is-soon \.broom-tag\.is-supporter span \{ white-space: normal; \}/, 'a long day wraps, never cut');
});

test('a tap tries it on for free, with the same keep step; again takes it off', () => {
  const r = rig();
  r.tell(born());
  r.open();
  r.card('beanie').click();
  assert.equal(r.posts.length, 0, 'trying on asks nothing');
  assert.equal(r.card('beanie').getAttribute('aria-pressed'), 'true');
  assert.equal(r.view.querySelector('.broom-dock .broom-keep-name').textContent, 'mybit_item_beanie');
  assert.deepEqual(r.lines(), ['mybit_shop_line']);
  r.card('beanie').click();
  assert.equal(r.view.querySelector('.broom-keep'), null);
  assert.equal(r.card('beanie').getAttribute('aria-pressed'), 'false');
});

test('an item it owns goes on and off at once, and a no from the server is said', async () => {
  const r = rig({ answers: { '/api/bit/wear': (body) => ({ ok: true, bit: born({ owned: ['cap', 'guitar'], worn: body.worn }) }) } });
  r.tell(born({ owned: ['cap', 'guitar'] }));
  r.open();
  r.card('guitar').click();
  await settle();
  assert.deepEqual(r.posts.at(-1), { url: '/api/bit/wear', body: { worn: ['cap', 'guitar'] } });
  assert.equal(r.card('guitar').getAttribute('aria-pressed'), 'true', 'the answer redraws the room');
  r.card('guitar').click();
  await settle();
  assert.deepEqual(r.posts.at(-1).body, { worn: ['cap'] });

  const off = rig();
  off.tell(born({ owned: ['cap', 'guitar'] }));
  off.open();
  off.card('guitar').click();
  await settle();
  assert.equal(off.view.querySelector('.broom-note').textContent, 'mybit_save_failed');
});

test('its Sparks beside the items open the Store\'s Sparks, without closing a sheet that is not there', () => {
  const r = rig();
  let shop = 0;
  let closed = 0;
  r.ctx.BitSheet = { close: () => { closed += 1; } };
  r.ctx.XenonCredits = { state: { status: 'ok', balance: 1250 }, onChange: () => () => {}, openShop: () => { shop += 1; }, refresh() {} };
  r.tell(born());
  r.open();
  const balance = r.view.querySelector('.broom-balance');
  assert.equal(balance.hidden, false);
  assert.equal(balance.textContent, '1,250');
  assert.equal(balance.getAttribute('aria-label'), 'mybit_balance');
  balance.click();
  assert.deepEqual([shop, closed], [1, 0]);
});

test('an egg hatches right in the Store; with no Bit known yet the view says it cannot open', async () => {
  const r = rig({ answers: { '/api/bit/hatch': { ok: true, bit: born() } } });
  r.tell({ ...born(), hatched: false, stage: 'egg' });
  r.open();
  assert.equal(r.view.querySelector('.broom-card'), null, 'no items before it hatches');
  // An egg has no rail, so on a wide screen the stage takes the whole room (no empty column beside it).
  assert.equal(r.view.querySelector('.broom-side').children.length, 0);
  assert.match(src('components/BitCompanion/BitCompanion.css'), /\.broom-in:has\(> \.broom-side:empty\) \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.equal(r.view.querySelector('.broom-dock .broom-line').textContent, 'mybit_egg_line');
  r.view.querySelector('[data-hatch]').click();
  await settle();
  assert.deepEqual(r.posts.map((p) => p.url), ['/api/bit/hatch']);
  assert.equal(r.view.querySelector('.broom-bit').getAttribute('aria-label'), 'mybit_poke');

  const none = rig();
  assert.equal(none.open(), null);
  assert.equal(none.view.querySelector('.cgal-status').textContent, 'mybit_unavailable');
  assert.equal(none.view.querySelector('.broom'), null);
});

test('one room per Store view: opening it again replaces it, and a view taken away stops at the next news', () => {
  const r = rig();
  r.tell(born());
  const first = r.open();
  const second = r.open();
  assert.notEqual(first, second);
  assert.equal(r.view.querySelectorAll('.broom').length, 1);
  assert.equal((r.winHandlers['xenon-bit'] || []).length, 1, 'the first one let go of the news');
  r.view.querySelector('.broom-who').click();
  assert.equal(r.ctx.BitRoom.escape(), true, 'Esc closes its drawer first');
  assert.equal(r.ctx.BitRoom.escape(), false, 'then the Store takes Esc');
  r.view.replaceChildren();
  r.tell(born({ days: 4 }));
  assert.equal((r.winHandlers['xenon-bit'] || []).length, 0, 'gone from the page: it stops');
});

test('the Store lists the room on its rail, gives it Esc first, and the Sparks view sends there', () => {
  const gallery = src('js/community-gallery/community-gallery.js');
  assert.match(gallery, /railRow\('__bit', t\('mybit_title'/);
  assert.match(gallery, /__bit: window\.BitRoom && 'bit'/);
  assert.match(gallery, /window\.BitRoom\.store\(viewEl\)/);
  assert.match(gallery, /if \(window\.BitRoom\?\.escape\(\)\) return;/);
  assert.match(gallery, /SparksStore\.render\(viewEl, \{[^}]*goView \}\)/);
  const sparks = src('js/store-supporters/sparks-store.js');
  assert.match(sparks, /window\.BitRoom && ctx\.goView/);
  assert.match(sparks, /ctx\.goView\('__bit'\)/);
  const page = src('index.html');
  const at = (f) => page.indexOf(`js/bit-companion/${f}.js`);
  assert.ok(ROOM.every((f, i) => at(f) > 0 && (!i || at(f) > at(ROOM[i - 1]))), 'each part before the room that uses it');
  assert.ok(at('room') < at('sheet'), 'and the room before its sheet');
  assert.equal(at('shelf'), -1, 'the old shelf is gone');
});

test("the rail's tabs: a picture of this Bit over each word, a place shown by what it wears there", () => {
  const r = rig();
  r.tell(born({ owned: ['cap', 'guitar'] }));
  r.open();
  const tabs = r.view.querySelectorAll('.broom-tab');
  assert.deepEqual(tabs.slice(0, 2).map((b) => b.dataset.tab), ['all', 'mine']);
  for (const b of tabs) {
    assert.ok(b.querySelector('.broom-tab-art svg rect'), `${b.dataset.tab}: a picture`);
    assert.match(b.querySelector('.broom-tab-word').textContent, /^mybit_(tab_all|mine|group_(supporter|shop)|tab_free|slot_\w+)$/);
  }
  const n = tabs.length;
  assert.equal(r.view.querySelector('.broom-tabs').style.getPropertyValue('--broom-tab-cols'), String(Math.ceil(n / Math.ceil(n / 4))), 'even rows on a wide rail, four across at most');
  const head = tabs.find((b) => b.dataset.tab === 'head');
  const cap = r.card('cap').querySelector('.broom-card-art svg');
  assert.equal(head.querySelector('svg').getAttribute('viewBox'), cap.getAttribute('viewBox'), 'the head: its own cap, the one it wears');
  head.click();
  assert.equal(head.getAttribute('aria-pressed'), 'true');
  assert.equal(tabs[0].getAttribute('aria-pressed'), 'false');
  const W = r.ctx.Xenon.bitWardrobe;
  const shown = r.view.querySelectorAll('.broom-card[data-item]');
  assert.ok(shown.length && shown.every((c) => W.item(c.dataset.item).slot === 'head'), 'only what goes on the head');
});

test('the share drawer: one choice on top, then only what it makes; its page on the site sits in its settings', () => {
  const r = rig();
  const opened = [];
  r.ctx.ShareCard = { open: (o) => opened.push(o) };
  r.tell(born());
  r.open();
  r.view.querySelectorAll('.broom-dock button').find((b) => b.textContent === 'mybit_share').click();
  const drawer = r.view.querySelector('.broom-drawer');
  const choices = drawer.querySelectorAll('.bitc-share-tabs button');
  assert.deepEqual(choices.map((b) => [b.dataset.share, b.getAttribute('aria-pressed')]), [['card', 'true'], ['setup', 'false']], 'no recorder, no month closed: card and setup');
  const pane = drawer.querySelector('.bitc-share-pane');
  assert.equal(pane.children.length, 1, 'one part at a time');
  assert.ok(pane.querySelector('.bitc-card .bitc-tools .bitc-choice'), 'its card with the ground under it');
  assert.equal(drawer.querySelector('.bitc-site'), null, 'no site choice among the sharing');
  choices[1].click();
  assert.deepEqual(choices.map((b) => b.getAttribute('aria-pressed')), ['false', 'true']);
  assert.equal(pane.querySelector('.bitc-card'), null, 'the card made way');
  pane.querySelector('.bitc-setup button').click();
  assert.deepEqual(opened.map((o) => o.source), ['setup']);
  r.view.querySelector('.broom-top .broom-tools .broom-icon').click();
  assert.ok(r.view.querySelector('.broom-drawer .bitc-site input'), 'its page on the site, in its settings');
});

test('the ways in: supporters, shop and free each have a tab, a mark and a colour, and open with what they are', async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-12-10T12:00:00Z') });
  const r = rig();
  r.tell(born({ owned: ['cap'], seasons: ['winter'] }));
  r.ctx.Xenon.constants = { supportUrl: (source) => `https://example.com/support?src=${source}` };
  let saved = false;
  r.ctx.XenonCredits = { supporterSaved: async () => saved };
  r.open();
  const ids = r.view.querySelectorAll('.broom-tab').map((b) => b.dataset.tab);
  assert.deepEqual(ids.slice(0, 5), ['all', 'mine', 'supporter', 'shop', 'free'], 'what it costs, right after its own');
  for (const way of ['supporter', 'shop', 'free']) {
    assert.ok(r.tab(way).classList.contains(`is-${way}`) && r.tab(way).querySelector('svg rect'), `${way}: its mark`);
  }
  const W = r.ctx.Xenon.bitWardrobe;
  r.tab('shop').click();
  const shop = r.view.querySelectorAll('.broom-card[data-item]');
  assert.ok(shop.length && shop.every((c) => W.item(c.dataset.item).source === 'shop'), 'only the Sparks ones, owned or not');
  assert.equal(r.view.querySelector('.broom-intro.is-shop').textContent, 'mybit_group_shopmybit_group_shop_line');
  r.tab('free').click();
  const free = r.view.querySelectorAll('.broom-card[data-item]');
  assert.ok(free.length && free.every((c) => ['trait', 'season', 'founder'].includes(W.item(c.dataset.item).source)), 'only what costs nothing');
  assert.ok(r.card('scarf').querySelector('.broom-tag.is-free svg rect'), 'the parcel under a free card');
  assert.equal(r.card('scarf').querySelector('.broom-tag').textContent, 'mybit_season_winter');
  r.tab('supporter').click();
  await settle();
  const join = r.view.querySelector('.broom-intro.is-supporter a.broom-btn');
  assert.ok(join, 'no pass on this PC: the way to get one');
  assert.equal(join.dataset.supportSource, 'bit-wardrobe');
  saved = true;
  r.tab('all').click();
  r.tab('supporter').click();
  await settle();
  assert.equal(r.view.querySelector('.broom-intro.is-supporter a'), null, 'a supporter is not asked again');
  const css = src('components/BitCompanion/BitCompanion.css');
  assert.match(css, /\.broom-tag\.is-free > svg, \.broom-intro\.is-free svg, \.broom-tab\.is-free \.broom-tab-art \{ color: var\(--broom-free\); \}/);
  assert.match(css, /\.broom-price \{[^}]*color: var\(--text\);/, "brass is the supporters' colour only");
});

test("a paired phone is never offered the pass, and the Store's band opens the room on the supporters' tab", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-12-10T12:00:00Z') });
  const r = rig();
  r.tell(born());
  r.ctx.Xenon.constants = { supportUrl: () => 'https://example.com/support' };
  r.ctx.RemoteSurface = { isRemote: () => true };
  r.open();
  r.tab('supporter').click();
  await settle();
  assert.equal(r.view.querySelector('.broom-intro a'), null, 'the pass is used on the PC');

  const views = [];
  const band = r.ctx.BitStoreBand.band({ goView: (id) => { views.push(id); r.open(); } });
  assert.ok(band.querySelector('.cst-bit-art svg rect'), 'its own Bit wearing it');
  assert.equal(band.querySelector('.cst-bit-words b').textContent, 'mybit_band_title');
  assert.ok(band.querySelector('.broom-tag.is-supporter svg path'), 'the heart, as on the card');
  assert.ok(band.querySelector('.cst-key.cst-bit-go'), 'one key, as the Store draws them');
  band.click();
  assert.deepEqual(views, ['__bit']);
  assert.equal(r.tab('supporter').getAttribute('aria-pressed'), 'true', 'the room opens on that tab');
  assert.deepEqual(Array.from(r.ctx.BitWardrobe.tried(), (it) => it.id), ['crown'], 'with the item already on its Bit');
  r.open();
  assert.equal(r.tab('all').getAttribute('aria-pressed'), 'true', 'once: the next visit starts from all');
});

test("the Store's band: this month's item only, never next month's, gone once owned or with no Bit yet", (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-12-10T12:00:00Z') });
  const r = rig();
  const { current } = r.ctx.BitStoreBand;
  const at = (iso) => new Date(iso);
  const items = [
    { id: 'a', source: 'supporter', month: '2026-11' }, { id: 'b', source: 'supporter', month: '2026-12' },
    { id: 'c', source: 'supporter', month: '2027-01' }, { id: 'd', source: 'shop' },
  ];
  assert.equal(current(items, at('2026-12-10T12:00:00Z')).id, 'b');
  assert.equal(current(items, at('2026-11-30T12:00:00Z')).id, 'a');
  assert.equal(current([{ ...items[1], offered: false }], at('2026-12-10T12:00:00Z')), null, 'one taken off the hub');
  assert.equal(current(items.slice(2), at('2026-12-10T12:00:00Z')), null);
  r.tell(born({ owned: ['cap', 'crown'] }));
  assert.equal(r.ctx.BitStoreBand.band({ goView() {} }), null, 'owned: nothing to offer');
  r.tell({ ok: true, hatched: false });
  assert.equal(r.ctx.BitStoreBand.band({ goView() {} }), null, 'an egg');
  const gallery = src('js/community-gallery/community-gallery.js');
  assert.equal((gallery.match(/window\.BitStoreBand\?\.band\(\{ goView \}\)/g) || []).length, 1, 'on the Supporters view');
  assert.equal((gallery.match(/window\.BitStoreBand\?\.shelf\(\{ goView, shelf \}\)/g) || []).length, 1, "the home's supporters stage has the shelf");
});

test("the Store's Bit shelf: this month's supporters' item first, then the shop's in a new order each day, never what it owns", (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-12-10T12:00:00Z') });
  const r = rig();
  const { offered } = r.ctx.BitStoreBand;
  const items = [
    { id: 'n', source: 'supporter', month: '2027-01' }, { id: 's', source: 'supporter', month: '2026-12' },
    ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, source: 'shop', price: 50 })), { id: 'g', source: 'shop', offered: false },
    { id: 'w', source: 'season' }, { id: 't', source: 'trait' },
  ];
  const day = (iso, owned = []) => Array.from(offered(items, owned, new Date(iso)), (it) => it.id);
  const today = day('2026-12-10T12:00:00Z');
  assert.equal(today[0], 's', "this month's supporters' item leads");
  assert.deepEqual([...today].sort(), ['a', 'b', 'c', 'd', 'e', 'f', 's'], 'only what can be kept: no next month, no free item, none taken off');
  assert.deepEqual(day('2026-12-10T20:00:00Z'), today, 'the same order all day');
  const days = new Set(['11', '12', '13', '14'].map((d) => day(`2026-12-${d}T09:00:00Z`).join()));
  assert.ok(days.size > 1, 'another order on other days');
  assert.deepEqual(day('2026-12-10T12:00:00Z', ['s', 'a']).filter((id) => id === 's' || id === 'a'), [], 'never what it owns');
  assert.equal(offered(items, [], new Date('2026-12-10T12:00:00Z'), 3).length, 3);

  r.tell(born());
  const views = [];
  let built = null;
  const fakeShelf = (title, list, opts) => {
    built = { title, list, opts };
    const wrap = r.ctx.document.createElement('section');
    list.forEach((it) => wrap.appendChild(opts.card(it)));
    return wrap;
  };
  const shelf = r.ctx.BitStoreBand.shelf({ goView: (id) => { views.push(id); r.open(); }, shelf: fakeShelf });
  assert.ok(shelf.classList.contains('is-bit'));
  assert.equal(built.title, 'mybit_title');
  assert.equal(built.opts.more, '__bit', 'see all opens the Bit');
  assert.equal(built.opts.lead, 'mybit_store_lead');
  assert.ok(built.list.length > 1 && built.list.length <= 10);
  const cards = [...shelf.querySelectorAll('.cst-bit-card')];
  assert.equal(cards[0].dataset.item, 'crown');
  assert.ok(cards[0].classList.contains('is-supporter') && cards[0].querySelector('.broom-tag.is-supporter svg'), "the supporters' card, with the heart");
  const shop = cards.find((c) => c.classList.contains('is-shop'));
  assert.ok(shop.querySelector('.cst-bit-art svg rect') && shop.querySelector('.broom-price'), 'the Bit wearing it, and its price');
  assert.ok(shop.style.getPropertyValue('--bit-wall'), "the card takes the Bit's stage colours");
  shop.click();
  assert.deepEqual(views, ['__bit']);
  assert.equal(r.tab('shop').getAttribute('aria-pressed'), 'true', 'the room opens on the shop');
  assert.deepEqual(Array.from(r.ctx.BitWardrobe.tried(), (it) => it.id), [shop.dataset.item], 'with that item already on its Bit');
  r.tell({ ok: true, hatched: false });
  assert.equal(r.ctx.BitStoreBand.shelf({ goView() {}, shelf: fakeShelf }), null, 'an egg has no shelf');
  const css = src('components/CommunityStore/CommunityStoreSupporters.css');
  assert.match(css, /\.cst-stage \.cst-shelf\.is-bit \.cst-row \{ --cols: var\(--cst-bit-cols, 6\); \}/);
});
