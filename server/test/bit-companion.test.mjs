// The person's own Bit on the dashboard (js/bit-companion/): where it stands
// (corner, by the clock, both, hidden, its tile), the egg until it hatches,
// stepping aside for the Vitals' Bit, what of the live stream makes it react
// (moments.js) on every place at once, and its room (the egg, its name and settings, items to try
// on and keep, bit-companion/room.js), each
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
const FILES = [...BIT_ENGINE, 'js/dialog-focus.js', 'js/ai/bit-app.js', 'js/bit-companion/wardrobe-keep.js', 'js/bit-companion/wardrobe-tabs.js', 'js/bit-companion/wardrobe.js',
  'js/bit-companion/card-dna.js', 'js/bit-companion/card.js', 'js/bit-companion/recap.js', 'js/bit-companion/clip.js', 'js/bit-companion/room-scenery.js',
  'js/bit-companion/room-panels.js', 'js/bit-companion/room.js', 'js/bit-companion/sheet.js', 'js/bit-companion/companion.js', 'js/bit-companion/tile.js', 'js/bit-companion/moments.js'];

const SEED = '0123456789abcdef';
const PREFS = { place: 'corner', reactions: 'normal', sounds: false, classic: false };
const egg = (prefs = {}) => ({ ok: true, hatched: false, stage: 'egg', founder: false, prefs: { ...PREFS, ...prefs }, everywhere: true, reactionsPerHour: 6 });
const born = (prefs = {}, more = {}) => ({
  ...egg(prefs), hatched: true, seed: SEED, number: 1284, local: false, born: '2026-11-24T20:00:00.000Z', name: '', worn: [], owned: [],
  days: 3, stage: 'baby', rarity: [{ gene: 'tip', id: 'leaf', chance: 0.01, oneIn: 100 }], lookOneIn: 52000,
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
  const key = (k) => (winHandlers.keydown || []).forEach((fn) => fn({ key: k, preventDefault() {}, stopPropagation() {} }));
  return {
    ctx, document, clock, posts, tell, send, reactions, fakeDirector, runTimers, key,
    corner: () => document.getElementById('bit-companion'),
    chip: () => clock.querySelector('.bitc-chip'),
    sheet: () => document.querySelector('.bitc-overlay'),
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

const dock = (r) => r.sheet().querySelector('.broom-dock');
const note = (r) => r.sheet().querySelector('.broom-note').textContent;
const openAbout = (r) => r.sheet().querySelector('.broom-who').click();

test('tapping the egg opens its room, and hatching shows who came out', async () => {
  const r = rig({ answers: { '/api/bit/hatch': { ok: true, bit: born() } } });
  r.tell(egg());
  r.corner().querySelector('.bitc-sprite').click();
  const sheet = r.sheet();
  assert.ok(sheet, 'the room opens');
  assert.equal(sheet.getAttribute('role'), 'dialog');
  assert.equal(sheet.getAttribute('aria-modal'), 'true');
  assert.equal(sheet.getAttribute('aria-labelledby'), sheet.querySelector('.broom-name').id, 'named by its title');
  assert.equal(r.document.activeElement, sheet, 'focus moves into it');
  assert.equal(sheet.querySelector('.broom-bit').getAttribute('aria-label'), 'mybit_hatch', 'the egg on the stage hatches too');
  assert.equal(sheet.querySelector('.broom-rail'), null, 'an egg has no items yet');
  const go = dock(r).querySelector('[data-hatch]');
  assert.ok(go, 'one button under it');

  go.click();
  await settle();
  assert.deepEqual(r.posts.map((p) => p.url), ['/api/bit/hatch']);
  assert.equal(r.ctx.BitApp.state().hatched, true, 'every place hears it');
  assert.equal(r.corner().querySelector('.bitc-sprite').getAttribute('aria-label'), 'mybit_open');
  assert.equal(sheet.querySelector('.broom-bit').getAttribute('aria-label'), 'mybit_poke', 'the Bit stands where the egg was');
  assert.equal(sheet.querySelector('.broom-rail'), null, 'the egg breaks before the items come out');
  assert.equal(dock(r).children.length, 0);
  r.runTimers();
  assert.ok(sheet.querySelector('.broom-rail .broom-card'), 'then its items');
  assert.equal(sheet.querySelector('.broom-id').textContent, 'mybit_number');
  openAbout(r);
  assert.ok(sheet.querySelector('.broom-drawer .bitc-name input'), 'its name, in the drawer');
  const facts = sheet.querySelectorAll('.bitc-facts li').map((li) => li.textContent);
  assert.deepEqual(facts, ['mybit_number', 'mybit_age', 'mybit_look_odds'], 'the odds of its whole look, never of one gene');
});

test('no internet: the egg says so and the button comes back', async () => {
  const r = rig({ answers: { '/api/bit/hatch': { ok: false, error: 'waiting' } } });
  r.tell(egg());
  r.ctx.BitSheet.open();
  const go = dock(r).querySelector('[data-hatch]');
  go.click();
  assert.equal(go.disabled, true, 'one tap at a time');
  await settle();
  assert.equal(go.disabled, false);
  assert.equal(note(r), 'mybit_hatch_wait');
  assert.equal(r.ctx.BitApp.state().hatched, false);
});

test('a place chosen in its settings moves the Bit, and a bad name says so', async () => {
  const r = rig({
    answers: {
      '/api/bit/prefs': (body) => ({ ok: true, bit: born({ ...body }) }),
      '/api/bit/name': { ok: false, error: 'bad_name' },
    },
  });
  r.tell(born());
  r.ctx.BitSheet.open();
  openAbout(r);
  const place = () => r.sheet().querySelectorAll('.broom-drawer .bitc-seg-btn').find((b) => b.textContent === 'mybit_place_topbar');
  assert.equal(place().getAttribute('aria-pressed'), 'false');
  place().click();
  await settle();
  assert.deepEqual(r.posts.at(-1), { url: '/api/bit/prefs', body: { place: 'topbar' } });
  assert.equal(r.corner(), null);
  assert.ok(r.chip(), 'it moved by the clock');
  assert.equal(place().getAttribute('aria-pressed'), 'true', 'the drawer stays open and follows the answer');

  const input = r.sheet().querySelector('.bitc-name input');
  input.value = 'x';
  (input._handlers.change || []).forEach((fn) => fn({}));
  await settle();
  assert.equal(note(r), 'mybit_name_bad');
});

const dressed = (more) => born({}, { owned: ['cap'], worn: ['cap'], ...more });
const card = (sheet, id) => sheet.querySelector(`.broom-card[data-item="${id}"]`);
const keepBar = (r) => r.sheet().querySelector('.broom-dock .broom-keep');
const keepLines = (r) => keepBar(r).querySelectorAll('.broom-keep-line').map((p) => p.textContent);
const mainBtn = (r) => keepBar(r).querySelector('button.broom-btn.is-main');

test('the items: a tap puts on or takes off what it owns, its own first and without a price', async () => {
  const r = rig({
    answers: { '/api/bit/wear': (body) => ({ ok: true, bit: dressed({ owned: ['cap', 'beanie'], worn: body.worn }) }) },
  });
  r.tell(dressed({ owned: ['cap', 'beanie'] }));
  r.ctx.BitSheet.open();
  const cap = card(r.sheet(), 'cap');
  assert.equal(cap.getAttribute('aria-pressed'), 'true', 'what it wears is marked');
  assert.ok(cap.querySelector('rect'), 'each item is drawn on this Bit, in its colours');
  assert.equal(cap.dataset.source, 'mine');
  assert.equal(cap.querySelector('.broom-price'), null, 'an owned item shows no price');
  assert.equal(cap.querySelector('.broom-tag').textContent, 'mybit_shelf_owned');
  const items = r.sheet().querySelectorAll('.broom-card[data-item]');
  assert.deepEqual(items.slice(0, 3).map((b) => b.dataset.source), ['mine', 'mine', 'shop'], 'what it owns comes first');

  card(r.sheet(), 'beanie').click();
  await settle();
  assert.deepEqual(r.posts.at(-1), { url: '/api/bit/wear', body: { worn: ['cap', 'beanie'] } });
  card(r.sheet(), 'cap').click();
  await settle();
  assert.deepEqual(r.posts.at(-1).body, { worn: ['beanie'] });
});

test('the items: tabs by place on the body, the shop first with its prices; trying on is free', async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-25T12:00:00Z') });
  const r = rig({});
  r.tell(dressed());
  r.ctx.BitSheet.open();
  const tabs = r.sheet().querySelectorAll('.broom-tab');
  assert.deepEqual(tabs.slice(0, 3).map((b) => b.textContent), ['mybit_tab_all', 'mybit_mine', 'mybit_group_supporter']);
  assert.ok(tabs.slice(3).length >= 4 && tabs.slice(3).every((b) => /^mybit_slot_/.test(b.textContent)), 'then each place on the body');
  assert.equal(tabs[0].getAttribute('aria-pressed'), 'true');

  const cards = r.sheet().querySelectorAll('.broom-card');
  assert.ok(cards[0].classList.contains('is-random'), 'a look at random comes first');
  assert.deepEqual([...new Set(cards.slice(1).map((b) => b.dataset.source))], ['mine', 'shop', 'trait'], "its own, then what can be had today; the supporters' in their tab");
  const prices = r.sheet().querySelectorAll('.broom-card[data-source="shop"] .broom-price').map((p) => Number(p.textContent));
  assert.ok(prices.length >= 20 && prices.every((n, i) => !i || n >= prices[i - 1]), 'every shop item shows its price, cheapest first');
  assert.match(card(r.sheet(), 'guitar').getAttribute('aria-label'), /^mybit_item_guitar, gallery_sparks_price/);
  // No season runs at the end of November: none is listed, each one is a surprise.
  assert.equal(r.sheet().querySelector('.broom-card[data-source="season"]'), null);

  const head = tabs.find((b) => b.textContent === 'mybit_slot_head');
  head.click();
  assert.equal(head.getAttribute('aria-pressed'), 'true');
  assert.equal(tabs[0].getAttribute('aria-pressed'), 'false');
  const W = r.ctx.Xenon.bitWardrobe;
  assert.ok(r.sheet().querySelectorAll('.broom-card').every((b) => W.item(b.dataset.item)?.slot === 'head'), 'one place: only its items');
  tabs[0].click();

  // December's crown is still to come at the end of November: shown, never tried on.
  tabs[2].click();
  card(r.sheet(), 'crown').click();
  assert.equal(card(r.sheet(), 'crown').getAttribute('aria-disabled'), 'true');
  assert.equal(r.ctx.BitWardrobe.preview(), null, 'not before its day');
  assert.equal(keepBar(r), null);
  tabs[0].click();

  const posted = r.posts.length;
  card(r.sheet(), 'bandana').click();
  assert.equal(r.posts.length, posted, 'trying on asks nothing');
  assert.ok(r.ctx.BitWardrobe.preview(), 'the big Bit wears it');
  assert.equal(card(r.sheet(), 'bandana').getAttribute('aria-pressed'), 'true');
  assert.equal(keepBar(r).querySelector('.broom-keep-name').textContent, 'mybit_item_bandana');
  assert.deepEqual(keepLines(r), ['mybit_shop_line'], 'a shop item: its price in a sentence');
  card(r.sheet(), 'bowtie').click();
  assert.deepEqual([...r.ctx.BitWardrobe.tried().map((it) => it.id)], ['bandana', 'bowtie'], 'shop items go on together, one per place');
  assert.deepEqual(keepLines(r), ['mybit_shop_line_many']);
  assert.match(mainBtn(r).getAttribute('aria-label'), /^mybit_keep_for_many/, 'kept together, for their total');

  keepBar(r).querySelector('.broom-keep-acts').children[0].click();
  assert.equal(r.ctx.BitWardrobe.tried().length, 0, 'take them off');
  assert.equal(keepBar(r), null);
  assert.equal(dock(r).querySelector('.broom-line').textContent, 'mybit_try_hint', 'back to its card and video');

  cards[0].click();
  const look = r.ctx.BitWardrobe.tried();
  assert.ok(look.length >= 2 && look.every((it) => it.source === 'shop'), 'a look at random, all from the shop');
  assert.equal(new Set(look.map((it) => it.slot)).size, look.length, 'one per place on the body');
  assert.equal(r.posts.length, posted, 'still free');
  r.ctx.BitSheet.close();
  assert.equal(r.ctx.BitWardrobe.preview(), null, 'closing takes it off');
});

test('the items: a running season shows only its own, and says how it comes', () => {
  const r = rig({});
  r.tell(dressed({ seasons: ['winter'] }));
  r.ctx.BitSheet.open();
  const scarf = card(r.sheet(), 'scarf');
  assert.equal(scarf.dataset.source, 'season', "winter's own item");
  assert.equal(scarf.querySelector('.broom-tag').textContent, 'mybit_season_winter');
  assert.equal(card(r.sheet(), 'witchHat'), null, 'not Halloween');
  assert.equal(card(r.sheet(), 'santaHat'), null, 'not Christmas either, until it starts');
  scarf.click();
  assert.deepEqual(keepLines(r), ['mybit_get_season']);
  assert.equal(mainBtn(r), null, 'nothing to buy: it comes with its season');
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
const supporters = (r) => r.sheet().querySelector('.broom-tab[data-tab="supporter"]').click();
const joinOf = (r) => keepBar(r).querySelector('[data-support-source]');

test("a supporter's item in its month is kept with the pass saved on this PC, and goes on at once", async (t) => {
  const r = keepRig(t, { answers: { '/api/bit/claim': (body) => ({ ok: true, bit: dressed({ owned: ['cap', body.item] }) }) } });
  supporters(r);
  assert.equal(card(r.sheet(), 'cape').getAttribute('aria-disabled'), 'true', "January's item already shows as the next one");
  card(r.sheet(), 'crown').click();
  await settle(30);
  const keep = mainBtn(r);
  assert.equal(keep.textContent, 'mybit_keep');
  assert.ok(shown(keep), 'a pass is saved: the keep button');
  assert.equal(shown(joinOf(r)), false);
  keep.click();
  await settle(30);
  assert.deepEqual(r.posts.at(-2), { url: '/api/bit/claim', body: { item: 'crown' } });
  assert.deepEqual(r.posts.at(-1), { url: '/api/bit/wear', body: { worn: ['cap', 'crown'] } });
  assert.equal(note(r), 'mybit_kept');
  assert.equal(card(r.sheet(), 'crown').dataset.source, 'mine', 'its own now');
  assert.equal(keepBar(r), null, 'and the step under it is back to its card');
});

test('without a pass the support sheet is offered instead of the keep button', async (t) => {
  const r = keepRig(t, { saved: false });
  supporters(r);
  card(r.sheet(), 'crown').click();
  await settle(30);
  const join = joinOf(r);
  assert.ok(shown(join));
  assert.equal(join.getAttribute('data-support-source'), 'bit-wardrobe');
  assert.match(join.href, /^https:/);
  assert.equal(shown(keepBar(r).querySelector('button.broom-btn.is-main')), false);
});

test('a run-out pass says so and offers renewing', async (t) => {
  const r = keepRig(t, { answers: { '/api/bit/claim': { ok: false, error: 'expired' } } });
  supporters(r);
  card(r.sheet(), 'crown').click();
  await settle(30);
  mainBtn(r).click();
  await settle(30);
  assert.equal(note(r), 'mybit_keep_expired');
  assert.ok(shown(joinOf(r)), 'renewing is one tap away');
});

test('an answer from the hub is never read as offline', async (t) => {
  const cases = [['revoked', 'sparks_err_revoked'], ['bad_code', 'preset_redeem_saved_stale'], ['bad_entry', 'mybit_keep_unavailable'],
    ['network', 'preset_redeem_offline']];
  for (const [error, line] of cases) {
    await t.test(error, async (st) => {
      const r = keepRig(st, { answers: { '/api/bit/claim': { ok: false, error } } });
      supporters(r);
      card(r.sheet(), 'crown').click();
      await settle(30);
      mainBtn(r).click();
      await settle(30);
      assert.equal(note(r), line);
    });
  }
});

test('a shop item is bought only with the box ticked, and short Sparks lead to the Store', async (t) => {
  const r = keepRig(t, { answers: { '/api/bit/buy': { ok: false, error: 'no_sparks', balance: 10, price: 50 } } });
  card(r.sheet(), 'bowtie').click();
  await settle(30);
  assert.deepEqual(keepLines(r), ['mybit_shop_line']);
  assert.match(mainBtn(r).getAttribute('aria-label'), /^mybit_keep_for/);
  assert.equal(r.sheet().querySelector('.broom-tick'), null, 'no box before asking to keep it');
  mainBtn(r).click();
  const buy = mainBtn(r);
  assert.equal(buy.textContent, 'mybit_buy');
  const posted = r.posts.length;
  buy.click();
  await settle(30);
  assert.equal(r.posts.length, posted, 'no box, no purchase');
  assert.equal(note(r), 'sparks_tick_first');

  r.sheet().querySelector('.broom-tick input').checked = true;
  buy.click();
  await settle(30);
  assert.deepEqual(r.posts.at(-1), { url: '/api/bit/buy', body: { item: 'bowtie', consent: 'item-2026-11' } });
  assert.equal(note(r), 'sparks_err_short');
  keepBar(r).querySelectorAll('button').find((b) => b.textContent === 'sparks_buy_more').click();
  assert.equal(r.credits.shop, 1, 'Buy Sparks opens the Store');
  assert.equal(r.ctx.BitSheet.isOpen(), false, 'the room steps aside');
});

test('news of the Bit that changes nothing under it leaves an open purchase open', async (t) => {
  const r = keepRig(t);
  card(r.sheet(), 'bowtie').click();
  await settle(30);
  mainBtn(r).click();
  const tick = r.sheet().querySelector('.broom-tick input');
  assert.ok(tick, 'the consent box is out');
  r.tell(dressed({ days: 4 }));
  assert.equal(r.sheet().querySelector('.broom-tick input'), tick, 'a new day redraws the rail, never the purchase');
  r.tell(dressed({ owned: ['cap', 'bowtie'] }));
  assert.equal(r.sheet().querySelector('.broom-tick'), null, 'kept on another place: the step changes');
});

test('a shop item bought on another PC comes back free, without the box', async (t) => {
  const r = keepRig(t, {
    answers: {
      '/api/community/sparks/owned?entryId=bit-bowtie': { ok: true, owned: true },
      '/api/bit/buy': (body) => ({ ok: true, bought: false, bit: dressed({ owned: ['cap', body.item] }) }),
    },
  });
  card(r.sheet(), 'bowtie').click();
  await settle(30);
  assert.equal(r.sheet().querySelector('.broom-tick'), null);
  const back = mainBtn(r);
  assert.equal(back.textContent, 'mybit_buy_back');
  assert.deepEqual(keepLines(r), ['mybit_buy_back_line'], 'it says it comes back free, with no price left to read as a second charge');
  back.click();
  await settle(30);
  assert.deepEqual(r.posts.at(-2), { url: '/api/bit/buy', body: { item: 'bowtie' } });
  assert.equal(r.credits.refreshed, 1);
});

test('on a paired phone a kept item only says it is done from the PC', async (t) => {
  const r = keepRig(t);
  r.ctx.RemoteSurface = { isRemote: () => true };
  card(r.sheet(), 'bowtie').click();
  await settle(30);
  assert.equal(r.sheet().querySelector('.broom-tick'), null);
  assert.equal(mainBtn(r), null);
  assert.ok(keepLines(r).includes('mybit_keep_pc_only'));
});

test('Esc closes the drawer first, then the room, each giving the focus back', () => {
  const r = rig();
  r.tell(born());
  const btn = r.corner().querySelector('.bitc-sprite');
  btn.focus();
  btn.click();
  assert.ok(r.ctx.BitSheet.isOpen());
  const who = r.sheet().querySelector('.broom-who');
  who.focus();
  who.click();
  const drawer = r.sheet().querySelector('.broom-drawer');
  assert.equal(drawer.hidden, false);
  assert.equal(drawer.getAttribute('aria-label'), 'mybit_about');
  r.key('Escape');
  assert.equal(drawer.hidden, true, 'the drawer goes first');
  assert.ok(r.ctx.BitSheet.isOpen(), 'the room stays');
  assert.equal(r.document.activeElement, who);
  r.key('Escape');
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
  later.ctx.BitMessages = { file: (_m, live) => { none.push(live); return Promise.resolve(true); }, firstLine: (s) => s };
  later.tell(born({}, { founder: true, born: '2026-01-01T00:00:00.000Z' }));
  later.tell({ ...egg({ place: 'off' }), founder: true });
  assert.deepEqual(none, [], 'hatched long ago, or no Bit wanted anywhere');
});

test('an egg is met once, on its first day, after whatever is on screen', () => {
  const store = new Map();
  const shelf = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const waiting = [];
  const AT = new Date().toISOString();
  const fresh = () => ({ ...egg(), eggAt: AT });
  const page = () => {
    const r = rig();
    r.ctx.localStorage = shelf;
    r.ctx.XenonInterrupts = { PRIORITY: { message: 10 }, whenIdle: (fn) => waiting.push(fn), registerOverlay() {} };
    return r;
  };
  const r = page();
  r.tell(fresh());
  r.tell(fresh());
  assert.equal(r.sheet(), null, 'not over the first-run choice');
  assert.equal(waiting.length, 1, 'asked once a page');
  waiting.shift()();
  assert.ok(r.sheet(), 'the egg is shown when the screen is free');
  const next = page();
  next.tell(fresh());
  waiting.splice(0).forEach((fn) => fn());
  assert.equal(next.sheet(), null, 'once on this device');
  const again = page();
  again.tell({ ...egg(), eggAt: new Date(Date.parse(AT) + 1000).toISOString() });
  waiting.splice(0).forEach((fn) => fn());
  assert.ok(again.sheet(), 'a new egg (a reinstall) is met again');
  store.clear();
  const old = page();
  old.tell({ ...egg(), eggAt: '2026-01-01T00:00:00.000Z' });
  old.tell({ ...fresh(), prefs: { ...PREFS, place: 'off' } });
  assert.equal(waiting.length, 0, 'an old egg or no Bit wanted: nothing opens');
  const founder = page();
  founder.tell({ ...fresh(), founder: true });
  waiting.shift()();
  assert.ok(founder.sheet(), 'a founder meets the egg right after the update too');
  assert.match(founder.sheet().textContent, /mybit_card_text/, 'and reads why it carries the mark');
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
