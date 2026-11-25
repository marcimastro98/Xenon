// The person's own Bit on the dashboard (js/bit-companion/): where it stands
// (corner, by the clock, both, hidden, its tile), the egg until it hatches,
// stepping aside for the Vitals' Bit, what of the live stream makes it react
// (moments.js) on every place at once, and its sheet (hatch, name, prefs, wardrobe), each
// answer of the server followed on every place.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { makeDom, settle } from './mini-dom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..');
const require = createRequire(import.meta.url);
const BIT_ENGINE = require('./fixtures/bit-engine.json');
const src = (p) => readFileSync(join(SERVER, p), 'utf8');
const FILES = [...BIT_ENGINE, 'js/ai/bit-app.js', 'js/bit-companion/wardrobe-keep.js', 'js/bit-companion/wardrobe.js', 'js/bit-companion/card.js', 'js/bit-companion/recap.js', 'js/bit-companion/clip.js', 'js/bit-companion/sheet.js', 'js/bit-companion/companion.js', 'js/bit-companion/tile.js', 'js/bit-companion/moments.js'];

const SEED = '0123456789abcdef';
const PREFS = { place: 'corner', reactions: 'normal', sounds: false, classic: false };
const egg = (prefs = {}) => ({ ok: true, hatched: false, stage: 'egg', founder: false, prefs: { ...PREFS, ...prefs }, everywhere: true, reactionsPerHour: 6 });
const born = (prefs = {}, more = {}) => ({
  ...egg(prefs), hatched: true, seed: SEED, number: 1284, local: false, born: '2026-11-24T20:00:00.000Z', name: '', worn: [], owned: [],
  days: 3, stage: 'baby', rarity: [{ gene: 'tip', id: 'leaf', chance: 0.01, oneIn: 100 }],
  traits: [{ id: 'gamer', item: 'headset', progress: 0.5, earned: false }], ...more,
});

function rig({ vitalsPet = false, answers = {} } = {}) {
  const { document } = makeDom();
  const clock = document.createElement('span');
  clock.id = 'clock-bit';
  clock.hidden = true;
  document.body.append(clock);
  const posts = [];
  const timers = [];
  const winHandlers = {};
  const ctx = {
    console, Math, Promise, queueMicrotask, Object, Array, String, Number, Set, Map, JSON, RegExp, Date, AbortController,
    document,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    addEventListener: (type, fn) => { (winHandlers[type] ||= []).push(fn); },
    removeEventListener() {},
    dispatchEvent: (e) => { (winHandlers[e.type] || []).forEach((fn) => fn(e)); return true; },
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    t: (key) => key,
    lang: 'en',
    SERVER: '',
    hubSettings: { vitals: { enabled: true, pet: { enabled: vitalsPet } } },
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
  const tell = (bit) => ctx.BitApp.heard(bit);
  const reactions = [];
  const stream = {};
  const es = { addEventListener: (name, fn) => { (stream[name] ||= []).push(fn); } };
  ctx.BitCompanion.listen(es);
  ctx.BitMoments.listen(es);
  const send = (name, data) => stream[name].forEach((fn) => fn({ data: JSON.stringify(data) }));
  const fakeDirector = () => { ctx.BitApp.director = () => ({ react: (name) => { reactions.push(name); return null; } }); };
  const runTimers = () => timers.splice(0).forEach((fn) => fn());
  return {
    ctx, document, clock, posts, tell, send, reactions, fakeDirector, runTimers,
    corner: () => document.getElementById('bit-companion'),
    chip: () => clock.querySelector('.bitc-chip'),
    sheet: () => document.querySelector('.bitc-sheet'),
  };
}

test('the egg waits in the corner until it hatches', () => {
  const r = rig();
  r.tell(egg());
  assert.ok(r.corner(), 'an egg in the corner');
  assert.equal(r.corner().querySelector('.bitc-sprite').getAttribute('aria-label'), 'mybit_egg_label');
  assert.equal(r.chip(), null);
  assert.equal(r.clock.hidden, true);
});

test('a hatched Bit stands where the person put it', () => {
  const r = rig();
  r.tell(born({ place: 'topbar' }));
  assert.equal(r.corner(), null);
  assert.ok(r.chip(), 'by the clock');
  assert.equal(r.clock.hidden, false);

  r.tell(born({ place: 'both' }));
  assert.ok(r.corner() && r.chip(), 'both places');

  r.tell(born({ place: 'off' }));
  assert.equal(r.corner(), null);
  assert.equal(r.chip(), null);
  assert.equal(r.clock.hidden, true, 'an empty clock slot hides again');
});

test('with the Vitals Bit on, that one stands in its places and this one steps aside', () => {
  const r = rig({ vitalsPet: true });
  r.tell(born({ place: 'both' }));
  assert.equal(r.corner(), null);
  assert.equal(r.chip(), null);
});

test('the live stream makes it react: games, heat once per climb, a new track, a return', () => {
  const r = rig();
  r.tell(born());
  r.fakeDirector();
  r.send('status', { gaming: false });
  r.send('status', { gaming: true });
  r.send('status', { gaming: false });
  r.send('system', { cpuTemp: 86, gpuTemp: 60 });
  r.send('system', { cpuTemp: 88, gpuTemp: 60 });
  r.send('system', { cpuTemp: 93, gpuTemp: 60 });
  r.send('system', { cpuTemp: 60, gpuTemp: 60 });
  r.send('system', { cpuTemp: 60, gpuTemp: 86 });
  r.send('media', { active: true, playbackStatus: 'Playing', title: 'One', artist: 'A' });
  r.send('media', { active: true, playbackStatus: 'Playing', title: 'One', artist: 'A' });
  r.send('media', { active: true, playbackStatus: 'Playing', title: 'Two', artist: 'A' });
  r.send('status', { idleSec: 700 });
  r.send('status', { idleSec: 1 });
  r.send('status', { idleSec: 1 });
  assert.deepEqual(r.reactions, ['gameStart', 'gameEnd', 'cpuHot', 'veryHot', 'gpuHot', 'trackChange', 'welcomeBack']);
});

test('an egg does not react, and a new stage is a moment of its own', async () => {
  const r = rig();
  r.tell(egg());
  r.fakeDirector();
  r.send('status', { gaming: false });
  r.send('status', { gaming: true });
  assert.deepEqual(r.reactions, []);
  r.tell(born({}, { stage: 'baby' }));
  r.tell(born({}, { stage: 'young', days: 7 }));
  await settle();
  assert.deepEqual(r.reactions, ['stage']);
});

test('a broken event changes nothing', () => {
  const r = rig();
  r.tell(born());
  assert.doesNotThrow(() => r.send('system', null));
  assert.doesNotThrow(() => r.ctx.BitCompanion.listen({ addEventListener: (_name, fn) => fn({ data: '{nope' }) }));
  assert.doesNotThrow(() => r.ctx.BitMoments.listen({ addEventListener: (_name, fn) => fn({ data: '{nope' }) }));
  assert.doesNotThrow(() => r.ctx.BitTile.onSystem(null));
});

test('tapping the egg opens its sheet, and hatching shows who came out', async () => {
  const r = rig({ answers: { '/api/bit/hatch': { ok: true, bit: born() } } });
  r.tell(egg());
  r.corner().querySelector('.bitc-sprite').click();
  const sheet = r.sheet();
  assert.ok(sheet, 'the sheet opens');
  assert.equal(sheet.getAttribute('role'), 'dialog');
  assert.equal(sheet.getAttribute('aria-modal'), 'true');
  assert.equal(r.document.activeElement, sheet, 'focus moves into it');
  const go = sheet.querySelector('.bitc-go');
  assert.ok(go, 'a hatch button');

  go.click();
  await settle();
  assert.deepEqual(r.posts.map((p) => p.url), ['/api/bit/hatch']);
  assert.equal(r.ctx.BitApp.state().hatched, true, 'every place hears it');
  assert.equal(r.corner().querySelector('.bitc-sprite').getAttribute('aria-label'), 'mybit_open');
  assert.equal(sheet.querySelector('.bitc-name'), null, 'the egg breaks before the card');
  r.runTimers();
  assert.ok(sheet.querySelector('.bitc-name input'), 'then the card: its name');
  const facts = sheet.querySelectorAll('.bitc-facts li').map((li) => li.textContent);
  assert.deepEqual(facts, ['mybit_number', 'mybit_age', 'mybit_rare_trait']);
});

test('no internet: the egg says so and the button comes back', async () => {
  const r = rig({ answers: { '/api/bit/hatch': { ok: false, error: 'waiting' } } });
  r.tell(egg());
  r.ctx.BitSheet.open();
  const go = r.sheet().querySelector('.bitc-go');
  go.click();
  assert.equal(go.disabled, true, 'one tap at a time');
  await settle();
  assert.equal(go.disabled, false);
  assert.equal(r.sheet().querySelector('.bitc-note').textContent, 'mybit_hatch_wait');
  assert.equal(r.ctx.BitApp.state().hatched, false);
});

test('a place chosen on the sheet moves the Bit, and a bad name says so', async () => {
  const r = rig({
    answers: {
      '/api/bit/prefs': (body) => ({ ok: true, bit: born({ ...body }) }),
      '/api/bit/name': { ok: false, error: 'bad_name' },
    },
  });
  r.tell(born());
  r.ctx.BitSheet.open();
  const place = r.sheet().querySelectorAll('.bitc-seg-btn').find((b) => b.textContent === 'mybit_place_topbar');
  assert.equal(place.getAttribute('aria-pressed'), 'false');
  place.click();
  await settle();
  assert.deepEqual(r.posts.at(-1), { url: '/api/bit/prefs', body: { place: 'topbar' } });
  assert.equal(r.corner(), null);
  assert.ok(r.chip(), 'it moved by the clock');
  const now = r.sheet().querySelectorAll('.bitc-seg-btn').find((b) => b.textContent === 'mybit_place_topbar');
  assert.equal(now.getAttribute('aria-pressed'), 'true', 'the sheet follows the answer');

  const input = r.sheet().querySelector('.bitc-name input');
  input.value = 'x';
  (input._handlers.change || []).forEach((fn) => fn({}));
  await settle();
  assert.equal(r.sheet().querySelector('.bitc-note').textContent, 'mybit_name_bad');
});

const GIFTS = { bolts: 7, gift: { ready: true, last: null }, odds: { c: 0.7, u: 0.25, r: 0.05 }, prices: { c: 6, u: 12, r: 30 } };
const dressed = (more) => born({}, { owned: ['cap'], worn: ['cap'], gifts: GIFTS, ...more });
const itemButton = (sheet, id) => sheet.querySelectorAll('.bitw-item').find((b) => b.querySelector('.bitw-item-name').textContent === `mybit_item_${id}`);

test("the wardrobe: today's gift opens once, a tap puts on or takes off what it owns", async () => {
  const opened = { ...GIFTS, gift: { ready: false, last: { day: '2026-12-03', item: 'beanie', bolts: 0 } } };
  const r = rig({
    answers: {
      '/api/bit/gift': { ok: true, bit: dressed({ owned: ['cap', 'beanie'], gifts: opened }) },
      '/api/bit/wear': (body) => ({ ok: true, bit: dressed({ owned: ['cap', 'beanie'], worn: body.worn, gifts: opened }) }),
    },
  });
  r.tell(dressed());
  r.ctx.BitSheet.open();
  const cap = itemButton(r.sheet(), 'cap');
  assert.equal(cap.getAttribute('aria-pressed'), 'true', 'what it wears is marked');
  assert.ok(cap.querySelector('rect'), "each item is drawn in this Bit's colours");
  assert.equal(r.sheet().querySelector('.bitw-bolts').textContent, 'mybit_bolts');

  r.sheet().querySelector('.bitw-open').click();
  await settle();
  assert.deepEqual(r.posts.at(-1), { url: '/api/bit/gift', body: {} });
  assert.equal(r.sheet().querySelector('.bitw-open'), null, 'once a day');
  assert.equal(r.sheet().querySelector('.bitw-gift-line').textContent, 'mybit_gift_got mybit_gift_next');
  assert.ok(itemButton(r.sheet(), 'beanie').className.includes('bitw-item') && !itemButton(r.sheet(), 'beanie').className.includes('is-locked'));

  itemButton(r.sheet(), 'beanie').click();
  await settle();
  assert.deepEqual(r.posts.at(-1), { url: '/api/bit/wear', body: { worn: ['cap', 'beanie'] } });
  itemButton(r.sheet(), 'cap').click();
  await settle();
  assert.deepEqual(r.posts.at(-1).body, { worn: ['beanie'] });
});

test('the wardrobe: anything is tried on for free, says how it is got, and bolts buy an everyday item', async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-25T12:00:00Z') });
  const r = rig({ answers: { '/api/bit/pick': { ok: true, bit: dressed({ owned: ['cap', 'bandana'], gifts: { ...GIFTS, bolts: 1 } }) } } });
  r.tell(dressed());
  r.ctx.BitSheet.open();
  const posted = r.posts.length;
  itemButton(r.sheet(), 'crown').click();
  assert.equal(r.posts.length, posted, 'trying on asks nothing');
  assert.ok(r.ctx.BitWardrobe.preview(), 'the big Bit wears it');
  assert.equal(itemButton(r.sheet(), 'crown').getAttribute('aria-pressed'), 'true');
  const lines = () => r.sheet().querySelectorAll('.bitw-detail-line').map((p) => p.textContent);
  assert.deepEqual(lines(), ['mybit_keep_soon'], "a supporters' item says when it comes");
  assert.equal(r.sheet().querySelector('.bitw-pick'), null, 'no price on what bolts cannot buy, nothing to keep before its month');

  itemButton(r.sheet(), 'bandana').click();
  assert.deepEqual(lines(), ['mybit_get_daily']);
  const pick = r.sheet().querySelector('.bitw-pick');
  assert.equal(pick.disabled, false, '7 bolts, a common item costs 6');
  pick.click();
  await settle();
  assert.deepEqual(r.posts.at(-1), { url: '/api/bit/pick', body: { item: 'bandana' } });
  assert.equal(r.ctx.BitWardrobe.preview(), null, 'once it is owned the try-on ends');

  itemButton(r.sheet(), 'topHat').click();
  assert.equal(r.sheet().querySelector('.bitw-pick').disabled, true, 'a rare item costs more than 1 bolt');
  assert.deepEqual(lines(), ['mybit_get_daily', 'mybit_pick_have']);
  r.ctx.BitSheet.close();
  assert.equal(r.ctx.BitWardrobe.preview(), null, 'closing takes it off');
});

// A supporter's item in its month and a shop item, with the pass and the wallet faked.
function keepRig(t, { saved = true, answers = {} } = {}) {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-12-02T12:00:00Z') });
  const r = rig({
    answers: {
      '/api/bit/wear': (body) => ({ ok: true, bit: dressed({ owned: ['cap', ...body.worn.filter((id) => id !== 'cap')], worn: body.worn }) }),
      ...answers,
    },
  });
  const credits = { refreshed: 0, shop: 0 };
  r.ctx.XenonCredits = {
    supporterSaved: async () => saved,
    refresh: () => { credits.refreshed += 1; },
    openShop: () => { credits.shop += 1; },
  };
  r.ctx.Xenon.constants = { supportUrl: (source) => `https://example.com/support?src=${source}` };
  r.tell(dressed());
  r.ctx.BitSheet.open();
  return { ...r, credits };
}

const shown = (el) => el && !el.hidden;

test("a supporter's item in its month is kept with the pass saved on this PC, and goes on at once", async (t) => {
  const r = keepRig(t, { answers: { '/api/bit/claim': (body) => ({ ok: true, bit: dressed({ owned: ['cap', body.item] }) }) } });
  assert.equal(itemButton(r.sheet(), 'cape').getAttribute('aria-pressed'), 'false', "January's item already shows as the next one");
  itemButton(r.sheet(), 'crown').click();
  await settle(30);
  const keep = r.sheet().querySelector('.bitw-detail .bitw-pick');
  assert.equal(keep.textContent, 'mybit_keep');
  assert.ok(shown(keep), 'a pass is saved: the keep button');
  assert.equal(shown(r.sheet().querySelector('.bitw-join')), false);
  keep.click();
  await settle(30);
  assert.deepEqual(r.posts.at(-2), { url: '/api/bit/claim', body: { item: 'crown' } });
  assert.deepEqual(r.posts.at(-1), { url: '/api/bit/wear', body: { worn: ['cap', 'crown'] } });
  assert.equal(r.sheet().querySelector('.bitc-note').textContent, 'mybit_kept');
});

test('without a pass the support sheet is offered instead of the keep button', async (t) => {
  const r = keepRig(t, { saved: false });
  itemButton(r.sheet(), 'crown').click();
  await settle(30);
  const join = r.sheet().querySelector('.bitw-join');
  assert.ok(shown(join));
  assert.equal(join.getAttribute('data-support-source'), 'bit-wardrobe');
  assert.match(join.href, /^https:/);
  assert.equal(shown(r.sheet().querySelector('.bitw-detail .bitw-pick')), false);
});

test('a run-out pass says so and offers renewing', async (t) => {
  const r2 = keepRig(t, { answers: { '/api/bit/claim': { ok: false, error: 'expired' } } });
  itemButton(r2.sheet(), 'crown').click();
  await settle(30);
  r2.sheet().querySelector('.bitw-detail .bitw-pick').click();
  await settle(30);
  assert.equal(r2.sheet().querySelector('.bitc-note').textContent, 'mybit_keep_expired');
  assert.ok(shown(r2.sheet().querySelector('.bitw-join')), 'renewing is one tap away');
});

test('a shop item is bought only with the box ticked, and short Sparks lead to the Store', async (t) => {
  const r = keepRig(t, { answers: { '/api/bit/buy': { ok: false, error: 'no_sparks', balance: 10, price: 50 } } });
  itemButton(r.sheet(), 'bowtie').click();
  await settle(30);
  assert.deepEqual(r.sheet().querySelectorAll('.bitw-detail-line').map((p) => p.textContent), ['mybit_shop_line']);
  const buy = r.sheet().querySelector('.bitw-detail .bitw-pick');
  assert.equal(buy.textContent, 'mybit_buy');
  const posted = r.posts.length;
  buy.click();
  await settle(30);
  assert.equal(r.posts.length, posted, 'no box, no purchase');
  assert.equal(r.sheet().querySelector('.bitc-note').textContent, 'sparks_tick_first');

  r.sheet().querySelector('.bitw-tick input').checked = true;
  buy.click();
  await settle(30);
  assert.deepEqual(r.posts.at(-1), { url: '/api/bit/buy', body: { item: 'bowtie', consent: 'item-2026-11' } });
  assert.equal(r.sheet().querySelector('.bitc-note').textContent, 'sparks_err_short');
  r.sheet().querySelector('.bitw-more').click();
  assert.equal(r.credits.shop, 1, 'Buy Sparks opens the Store');
  assert.equal(r.ctx.BitSheet.isOpen(), false, 'the sheet steps aside');
});

test('a shop item bought on another PC comes back free, without the box', async (t) => {
  const r = keepRig(t, {
    answers: {
      '/api/community/sparks/owned?entryId=bit-bowtie': { ok: true, owned: true },
      '/api/bit/buy': (body) => ({ ok: true, bought: false, bit: dressed({ owned: ['cap', body.item] }) }),
    },
  });
  itemButton(r.sheet(), 'bowtie').click();
  await settle(30);
  assert.equal(r.sheet().querySelector('.bitw-tick'), null);
  const buy = r.sheet().querySelector('.bitw-detail .bitw-pick');
  assert.equal(buy.textContent, 'mybit_buy_back');
  const lines = [...r.sheet().querySelectorAll('.bitw-detail .bitw-detail-line')].map((p) => p.textContent);
  assert.ok(lines.includes('mybit_buy_back_line'), 'the price line says it comes back free');
  assert.ok(!lines.includes('mybit_shop_line'), 'no price left to read as a second charge');
  buy.click();
  await settle(30);
  assert.deepEqual(r.posts.at(-2), { url: '/api/bit/buy', body: { item: 'bowtie' } });
  assert.equal(r.credits.refreshed, 1);
});

test('on a paired phone a kept item only says it is done from the PC', async (t) => {
  const r = keepRig(t);
  r.ctx.RemoteSurface = { isRemote: () => true };
  itemButton(r.sheet(), 'bowtie').click();
  await settle(30);
  assert.equal(r.sheet().querySelector('.bitw-tick'), null);
  assert.equal(r.sheet().querySelector('.bitw-detail .bitw-pick'), null);
  assert.ok(r.sheet().querySelectorAll('.bitw-detail-line').some((p) => p.textContent === 'mybit_keep_pc_only'));
});

test('Escape closes the sheet and gives the focus back', () => {
  const r = rig();
  r.tell(born());
  const btn = r.corner().querySelector('.bitc-sprite');
  btn.focus();
  btn.click();
  assert.ok(r.ctx.BitSheet.isOpen());
  (r.document._handlers.keydown || []).forEach((fn) => fn({ key: 'Escape' }));
  assert.equal(r.ctx.BitSheet.isOpen(), false);
  assert.equal(r.sheet(), null);
  assert.equal(r.document.activeElement, btn);
});

test('the own Bit keeps its look on its places even with the classic Bit chosen for the app', () => {
  const r = rig();
  r.tell(born({ classic: true }, { everywhere: false }));
  assert.equal(r.ctx.BitApp.own(), null, 'the rest of the app is classic');
  assert.ok(r.ctx.BitApp.personal(), 'the companion still has its own look');
  assert.ok(r.ctx.BitApp.director(), 'and its own rhythm');
});

// A tile of the dashboard, as index.html holds it.
function tileIn(r) {
  const section = r.document.createElement('section');
  section.setAttribute('data-dashboard-widget', 'bit');
  const mount = r.document.createElement('div');
  mount.className = 'bit-tile-mount';
  section.append(mount);
  r.document.body.append(section);
  return mount;
}

test('the Bit tile shows the egg, then the hatched Bit with its name and age, and opens its sheet', () => {
  const r = rig();
  const mount = tileIn(r);
  r.ctx.BitTile.renderWidgets();
  assert.equal(mount.children.length, 0, 'nothing before the server has said anything');
  r.tell(egg());
  assert.equal(mount.querySelector('.bitt-name').textContent, 'mybit_egg_label');
  assert.equal(mount.querySelector('.bitt-line').textContent, 'mybit_tap_hatch');
  r.tell(born({}, { name: 'Pixel', stage: 'young', days: 12 }));
  assert.equal(mount.querySelector('.bitt-name').textContent, 'Pixel');
  assert.equal(mount.querySelector('.bitt-line').textContent, 'mybit_age');
  const sprite = mount.querySelector('.bitt-sprite');
  assert.equal(sprite.getAttribute('aria-label'), 'mybit_open');
  r.tell(born({}, { name: 'Pixel', stage: 'young', days: 12, reactionsPerHour: 2 }));
  assert.equal(mount.querySelector('.bitt-sprite'), sprite, 'a word that changes nothing shown draws nothing again');
  sprite.click();
  assert.ok(r.sheet(), 'the sheet opens from the tile');
});

test('a moment plays on every own Bit of the page at once: corner, clock and tile', () => {
  const r = rig();
  const mount = tileIn(r);
  r.tell(born({ place: 'both' }));
  r.ctx.BitTile.renderWidgets();
  const played = [];
  r.ctx.BitApp.playerFor = (host) => ({ play: (id) => played.push([host.className, id]) });
  r.ctx.BitApp.director = () => ({ react: () => 'fanSweat' });
  r.send('system', { cpuTemp: 90, gpuTemp: 40 });
  assert.deepEqual(played.map(([cls]) => cls).sort(), ['bitc-chip', 'bitc-sprite', 'bitt-sprite']);
  assert.ok(played.every(([, id]) => id === 'fanSweat'));
  assert.ok(mount.querySelector('[data-own-bit]'));
});

test('on a layer page the tile takes the stream through its own handlers', () => {
  const r = rig();
  const mount = tileIn(r);
  r.ctx.BitTile.onBit(born({}, { name: 'Pixel' }));
  assert.equal(r.ctx.BitApp.state().name, 'Pixel');
  assert.equal(mount.querySelector('.bitt-name').textContent, 'Pixel');
  r.fakeDirector();
  r.ctx.BitTile.onStatus({ gaming: false });
  r.ctx.BitTile.onStatus({ gaming: true });
  r.ctx.BitTile.onMedia({ active: true, playbackStatus: 'Playing', title: 'One' });
  r.ctx.BitTile.onMedia({ active: true, playbackStatus: 'Playing', title: 'Two' });
  assert.deepEqual(r.reactions, ['gameStart', 'trackChange']);
});

test('a founder\'s egg files one card to hatch it; a fresh hatch takes it back, an old one asks nothing', () => {
  const r = rig();
  const filed = [];
  r.ctx.BitMessages = { file: (messages, live) => { filed.push({ messages, live }); return Promise.resolve(true); }, firstLine: (s) => s };
  r.tell(egg());
  r.tell(egg({ place: 'off' }));
  assert.equal(filed.length, 0, 'not a founder: the egg in the corner is enough');
  const founder = { ...egg(), founder: true };
  r.tell(founder);
  r.tell(founder);
  assert.equal(filed.length, 1, 'once a page');
  const [card] = filed[0].messages;
  assert.deepEqual([card.id, card.kind, card.surface, card.action.type, card.title], ['bit:hatch', 'bit', 'dashboard', 'bit', 'mybit_card_title']);
  r.tell(born({}, { founder: true, born: new Date().toISOString() }));
  assert.equal(JSON.stringify(filed[1]), '{"messages":[],"live":{"bit":[]}}');
  const later = rig();
  const none = [];
  later.ctx.BitMessages = { file: (m, live) => { none.push(live); return Promise.resolve(true); }, firstLine: (s) => s };
  later.tell(born({}, { founder: true, born: '2026-01-01T00:00:00.000Z' }));
  later.tell({ ...egg({ place: 'off' }), founder: true });
  assert.deepEqual(none, [], 'hatched long ago, or no Bit wanted anywhere');
});

test('a closed month is told once, as a message of Bit with its card; a new month takes an unread one back', () => {
  const r = rig();
  const filed = [];
  r.ctx.BitMessages = { file: (messages, live) => { filed.push(JSON.parse(JSON.stringify({ messages, live }))); return Promise.resolve(true); }, firstLine: (s) => s };
  const nov = { key: '2026-11', days: 12, gaming: 600, music: 0, coding: 0, hot: 0, night: 0, early: 0, gifts: 2, items: [] };
  const old = { born: '2026-01-01T00:00:00.000Z' };
  r.tell(born({}, { ...old, recap: { month: nov, year: null } }));
  r.tell(born({}, { ...old, name: 'Pixel', recap: { month: nov, year: null } }));
  assert.equal(filed.length, 1, 'once a page for the same month');
  const [msg] = filed[0].messages;
  assert.deepEqual([msg.id, msg.kind, msg.surface, msg.action.type, msg.action.label, msg.body], ['bit:recap:2026-11', 'bit', 'dashboard', 'bit', 'mybit_recap_open', 'mybit_recap_msg']);
  assert.deepEqual(filed[0].live, { bit: ['bit:recap:2026-11'] });
  r.tell(born({}, { ...old, recap: { month: { ...nov, key: '2026-12' }, year: { ...nov, key: '2026' } } }));
  assert.deepEqual(filed[1].live, { bit: ['bit:recap:2026', 'bit:recap:2026-12'] }, 'an unread November goes');
  const off = rig();
  const none = [];
  off.ctx.BitMessages = { file: (m) => { none.push(m); return Promise.resolve(true); }, firstLine: (s) => s };
  off.tell(born({ place: 'off' }, { ...old, recap: { month: nov, year: null } }));
  off.tell(born({}, { ...old, recap: { month: null, year: null } }));
  assert.deepEqual(none, [], 'no Bit wanted anywhere, or no month closed yet');
});
