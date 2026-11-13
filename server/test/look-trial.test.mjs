// "Try it on my screen" (js/look-trial.js) and the melt it rides on (js/view-melt.js). An update
// keeps the look it found: the new one goes on only by the person's tap, what they had is saved
// first, and one tap brings it back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync as readFileSyncRaw } from 'node:fs';
import vm from 'node:vm';
import { makeDom, settle } from './mini-dom.mjs';
import { engineSource } from './engine-source.mjs';

const readFileSync = (p) => readFileSyncRaw(p, 'utf8').replace(/\r\n/g, '\n');
const src = (p) => readFileSync(new URL('../' + p, import.meta.url));
const TRIAL = src('js/look-trial.js');
const MELT = src('js/view-melt.js');

function load({ styleMode = 'glass', remote = false, cards = [], live = 'old', api = true, wallpaperGone = false } = {}) {
  const { document } = makeDom();
  const make = document.createElement;
  document.createElement = (tag) => {
    const node = make(tag);
    node.focus = () => { document.activeElement = node; };
    return node;
  };
  const log = [];
  const state = { cards: [...cards], live };
  const ctx = { document, console, hubSettings: { styleMode }, __xenonRemote: remote };
  ctx.window = ctx;
  ctx.getCustomThemes = () => state.cards;
  ctx.themeMatchesLive = (card) => card.look === state.live;
  ctx.snapshotCurrentTheme = () => ({ look: state.live });
  ctx.addThemeCard = (snapshot, name) => {
    log.push('save');
    if (state.cards.some((card) => card.look === snapshot.look)) return null;
    const card = { id: 'card-' + (state.cards.length + 1), name, ...snapshot };
    state.cards.push(card);
    return card;
  };
  if (api) {
    ctx.applyThemeById = (id) => {
      log.push('apply:' + id);
      state.live = id === 'liquid' ? 'liquid' : state.cards.find((card) => card.id === id).look;
      ctx.hubSettings.styleMode = id === 'liquid' ? 'liquid' : styleMode;
    };
  }
  ctx.Image = class {
    decode() {
      log.push('wallpaper');
      return wallpaperGone ? Promise.reject(new Error('gone')) : Promise.resolve();
    }
  };
  ctx.XenonMelt = (change) => {
    log.push('melt');
    change();
    return Promise.resolve();
  };
  vm.createContext(ctx);
  vm.runInContext(TRIAL, ctx);
  const options = {
    tr: (key) => key,
    mountBit: () => ({ play: (clip) => log.push('bit:' + clip), destroy: () => log.push('bit-gone') }),
    stepOut: () => log.push('out'),
    comeBack: (kept) => log.push('back:' + kept),
  };
  return { ctx, document, log, state, options, trial: ctx.LookTrial };
}

const card = (d) => d.document.body.querySelector('.wn-look');
const keep = (d) => d.document.body.querySelector('.wn-look-keep');
const back = (d) => d.document.body.querySelector('.wn-look-back');
const many = (count) => Array.from({ length: count }, (_, i) => ({ id: 'c' + i, look: 'other' + i }));

test('offered to a person on another look, with room in the gallery', () => {
  assert.equal(load().trial.offered(), true);
  assert.equal(load({ styleMode: 'retro' }).trial.offered(), true);
});

test('not offered where it has nothing to do or cannot work', () => {
  assert.equal(load({ styleMode: 'liquid' }).trial.offered(), false, 'already on it');
  assert.equal(load({ remote: true }).trial.offered(), false, 'a paired device shows the look of the PC');
  assert.equal(load({ api: false }).trial.offered(), false, 'a window with no themes');
});

test('a full gallery cannot hold the old look, so the way back is not promised', () => {
  assert.equal(load({ cards: many(24) }).trial.offered(), false, 'no 25th card');
  assert.equal(load({ cards: many(23) }).trial.offered(), true);
  const heavy = [{ id: 'big', look: 'x', picture: 'x'.repeat(4000000) }];
  assert.equal(load({ cards: heavy }).trial.offered(), false, 'past the size every card would lose its pictures');
});

test('a look already saved needs no room', () => {
  const cards = [...many(23), { id: 'mine', look: 'old' }];
  assert.equal(load({ cards }).trial.offered(), true);
});

test('the limits are the ones the server keeps', () => {
  const server = engineSource();
  const start = server.indexOf('function sanitizeCustomThemes');
  const body = server.slice(start, server.indexOf('\n}\n', start));
  assert.equal(Number(TRIAL.match(/MAX_BYTES = (\d+)/)[1]), Number(body.match(/CAP = (\d+)/)[1]));
  assert.equal(Number(TRIAL.match(/MAX_CARDS = (\d+)/)[1]), Number(body.match(/\.slice\(0, (\d+)\)/)[1]));
});

test('the old look is saved before the new one goes on, in one melt', async () => {
  const d = load();
  await d.trial.run(d.options);
  assert.deepEqual(d.log.slice(0, 5), ['wallpaper', 'save', 'melt', 'apply:liquid', 'out']);
  assert.equal(d.state.cards[0].name, 'wn_look_saved');
  assert.equal(d.state.cards[0].look, 'old');
});

test('a wallpaper that does not load does not stop the trial', async () => {
  const d = load({ wallpaperGone: true });
  await d.trial.run(d.options);
  assert.ok(d.log.includes('apply:liquid'));
  assert.ok(card(d));
});

test('the card says what is on screen and leaves the page usable', async () => {
  const d = load();
  await d.trial.run(d.options);
  const node = card(d);
  assert.equal(node.getAttribute('role'), 'group', 'not a dialog: the dashboard stays in use');
  assert.equal(node.getAttribute('aria-label'), 'wn_look_line');
  assert.equal(node.querySelector('.wn-look-line').textContent, 'wn_look_line');
  assert.equal(d.document.activeElement, keep(d));
  assert.ok(d.log.includes('bit:hello'));
});

test('one tap puts back what they had', async () => {
  const d = load();
  await d.trial.run(d.options);
  back(d).click();
  await settle();
  assert.deepEqual(d.log.slice(-4), ['melt', 'bit-gone', 'apply:card-1', 'back:false']);
  assert.equal(d.state.live, 'old');
  assert.equal(card(d), null);
});

test('keeping it changes nothing more, and the old look stays in the gallery', async () => {
  const d = load();
  await d.trial.run(d.options);
  keep(d).click();
  await settle();
  assert.deepEqual(d.log.slice(-3), ['melt', 'bit-gone', 'back:true']);
  assert.equal(d.state.live, 'liquid');
  assert.equal(d.state.cards.length, 1);
  assert.equal(card(d), null);
});

test('a double tap decides once', async () => {
  const d = load();
  await d.trial.run(d.options);
  const key = back(d);
  key.click();
  key.click();
  await settle();
  assert.equal(d.log.filter((entry) => entry === 'back:false').length, 1);
});

test('a second tap on the key while it runs starts nothing', async () => {
  const d = load();
  await Promise.all([d.trial.run(d.options), d.trial.run(d.options)]);
  assert.equal(d.log.filter((entry) => entry === 'apply:liquid').length, 1);
  assert.equal(d.document.body.querySelectorAll('.wn-look').length, 1);
});

test('a second try makes no second card', async () => {
  const d = load();
  await d.trial.run(d.options);
  back(d).click();
  await settle();
  await d.trial.run(d.options);
  assert.equal(d.state.cards.length, 1);
  back(d).click();
  await settle();
  assert.equal(d.log.filter((entry) => entry === 'apply:card-1').length, 2);
});

test('a look the gallery already holds goes back to that same card', async () => {
  const d = load({ cards: [{ id: 'mine', look: 'old' }] });
  await d.trial.run(d.options);
  assert.equal(d.state.cards.length, 1);
  back(d).click();
  await settle();
  assert.ok(d.log.includes('apply:mine'));
});

test('it runs only from the key on its sheet, never by itself', () => {
  const callers = readdirSync(new URL('../js/', import.meta.url))
    .filter((name) => name.endsWith('.js') && name !== 'look-trial.js')
    .filter((name) => /look\.run\(|LookTrial\.run\(/.test(src('js/' + name)));
  assert.deepEqual(callers, ['whats-new.js']);
  const sheets = src('js/whats-new.js');
  assert.match(sheets, /h\.go === 'look'[^\n]*\n?[^\n]*wn_try_look'\), \(e\) => ctx\.tryLook/);
  assert.match(sheets, /h\.go !== 'look' \|\| opts\.look/, 'no trial on offer, no sheet');
});

test('a window that cannot run it does not count its sheet', () => {
  assert.match(src('js/screen-release.js'), /highlights\.filter\(\(h\) => h\.go !== 'look'\)\.length/);
});

function meltIn({ transition = true, body = [], reduced = false, fails = false } = {}) {
  const root = new Set();
  const log = [];
  const document = {
    body: { classList: { contains: (name) => body.includes(name) } },
    documentElement: { classList: { add: (name) => root.add(name), remove: (name) => root.delete(name) } },
  };
  if (transition) {
    document.startViewTransition = (change) => {
      log.push('transition:' + [...root].join());
      change();
      return { finished: fails ? Promise.reject(new Error('skipped')) : Promise.resolve() };
    };
  }
  const ctx = { document, console: { warn: () => log.push('warned') } };
  ctx.window = ctx;
  ctx.matchMedia = () => ({ matches: reduced });
  vm.createContext(ctx);
  vm.runInContext(MELT, ctx);
  return { melt: ctx.XenonMelt, log, root };
}

test('the melt runs the change inside one slow transition and cleans up after it', async () => {
  const m = meltIn();
  await m.melt(() => m.log.push('change'));
  assert.deepEqual(m.log, ['transition:xenon-melting', 'change']);
  assert.equal(m.root.size, 0);
});

test('where nothing should move, the change simply happens', async () => {
  for (const options of [{ transition: false }, { body: ['low-power-gpu'] }, { body: ['perf-mode'] }, { reduced: true }]) {
    const m = meltIn(options);
    await m.melt(() => m.log.push('change'));
    assert.deepEqual(m.log, ['change'], JSON.stringify(options));
    assert.equal(m.root.size, 0);
  }
});

test('a transition the browser drops still ends clean', async () => {
  const m = meltIn({ fails: true });
  await m.melt(() => m.log.push('change'));
  assert.deepEqual(m.log, ['transition:xenon-melting', 'change', 'warned']);
  assert.equal(m.root.size, 0);
});

test('the slow melt has its rule, and the page loads the helper before what uses it', () => {
  assert.match(src('styles/global.css'), /html\.xenon-melting::view-transition-old\(root\)/);
  const page = src('index.html');
  const at = (file) => page.indexOf(`src="js/${file}"`);
  assert.ok(at('view-melt.js') > 0);
  assert.ok(at('view-melt.js') < at('usage-ask.js'));
  assert.ok(at('view-melt.js') < at('look-trial.js'));
});
