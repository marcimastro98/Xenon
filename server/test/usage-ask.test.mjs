// "How do you want to use Xenon?" (js/usage-ask.js): asked once, in the app that
// draws widgets, after the screen question and before the tour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync as readFileSyncRaw } from 'node:fs';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const readFileSync = (p) => readFileSyncRaw(p, 'utf8').replace(/\r\n/g, '\n');
const src = (p) => readFileSync(new URL('../' + p, import.meta.url));
const SRC = src('js/usage-ask.js');
const USAGE_MODE = src('js/usage-mode.js');

function load({ native = true, caps = { layers: true }, usageMode = '', remote = false, layerPage = false } = {}) {
  const { document } = makeDom();
  const make = document.createElement;
  document.createElement = (t) => {
    const el = make(t);
    el.focus = () => { document.activeElement = el; };
    return el;
  };
  const keyHandlers = [];
  document.addEventListener = (type, fn) => { if (type === 'keydown') keyHandlers.push(fn); };
  document.removeEventListener = (_type, fn) => {
    const i = keyHandlers.indexOf(fn);
    if (i >= 0) keyHandlers.splice(i, 1);
  };
  const saved = [];
  const freezes = [];
  const ctx = {
    document, console,
    hubSettings: { usageMode, layers: { menuKey: 'ctrl+alt+m' } },
    t: (k) => ({ usage_ask_sub: 'Cambia dal menu ({key}).', xmenu_mode_widgets: 'Solo widget', usage_ask_chosen: 'Scelto' }[k] || k),
    updateUsageMode: (v) => saved.push(v),
    isLayerPage: () => layerPage,
  };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.top = ctx;
  ctx.__XENON_NATIVE__ = native;
  ctx.__XENON_NATIVE_CAPS__ = caps;
  ctx.__xenonRemote = remote;
  ctx.ambientFreeze = (who, on) => freezes.push([who, on]);
  ctx.DeckShortcuts = { formatShortcut: (c) => c.toUpperCase() };
  vm.createContext(ctx);
  vm.runInContext(USAGE_MODE, ctx);
  vm.runInContext(SRC, ctx);
  const key = (k) => keyHandlers.slice().forEach((fn) => fn({ key: k, preventDefault() {} }));
  return { ctx, document, saved, freezes, key, keyHandlers, U: ctx.UsageAsk };
}

const keyRepeat = (d, k) => d.keyHandlers.slice().forEach((fn) => fn({ key: k, repeat: true, preventDefault() {} }));
const cards = (d) => d.document.querySelectorAll('.ua-card');
const onCard = (d) => d.document.querySelector('.ua-card.is-on');

test('asked only in the app that draws widgets, only once, never on a phone, a layer or a frame', () => {
  assert.equal(load().U.shouldAsk(), true);
  assert.equal(load({ native: false }).U.shouldAsk(), false, 'browser');
  assert.equal(load({ caps: {} }).U.shouldAsk(), false, 'a shell that cannot draw widgets');
  assert.equal(load({ usageMode: 'both' }).U.shouldAsk(), false, 'already answered');
  assert.equal(load({ usageMode: 'nonsense' }).U.shouldAsk(), true, 'a broken value counts as not asked');
  assert.equal(load({ remote: true }).U.shouldAsk(), false, 'paired device');
  assert.equal(load({ layerPage: true }).U.shouldAsk(), false, 'a layer window');
  const framed = load();
  framed.ctx.top = {};
  assert.equal(framed.U.shouldAsk(), false, 'inside a frame');
  assert.equal(load({ native: false }).U.maybeStart(), false);
});

test('three radio cards, the dashboard preselected, the menu key in the line under the title', () => {
  const d = load();
  assert.equal(d.U.maybeStart(), true);
  assert.equal(d.U.isOpen(), true);
  const overlay = d.document.querySelector('.ua-overlay');
  assert.equal(overlay.getAttribute('role'), 'dialog');
  assert.match(overlay.className, /\bsp-overlay\b/, 'the same dialog as the screen question');
  assert.equal(d.document.querySelector('.ua-cards').getAttribute('role'), 'radiogroup');
  assert.equal(cards(d).length, 3);
  assert.deepEqual(cards(d).map((c) => c.getAttribute('aria-checked')), ['true', 'false', 'false']);
  assert.equal(d.document.querySelector('.sp-sub').textContent, 'Cambia dal menu (CTRL+ALT+M).');
  assert.equal(d.document.activeElement, onCard(d), 'focus starts on the chosen card');
  assert.deepEqual(d.freezes, [['usage-ask', true]]);
  assert.equal(d.U.maybeStart(), true, 'a second call keeps the one dialog');
  assert.equal(d.document.querySelectorAll('.ua-overlay').length, 1);
});

test('a tap picks, Continue saves once and runs what comes next', () => {
  const d = load();
  const after = [];
  d.U.maybeStart((m) => after.push(m));
  cards(d)[1].click();
  assert.equal(onCard(d).querySelector('b').textContent, 'Solo widget');
  assert.equal(onCard(d).querySelector('.ua-state').textContent, 'Scelto');
  assert.deepEqual(d.saved, [], 'picking alone saves nothing');
  d.document.querySelector('.ua-go').click();
  assert.deepEqual(d.saved, ['widgets']);
  assert.deepEqual(after, ['widgets']);
  assert.equal(d.U.isOpen(), false);
  assert.equal(d.document.querySelector('.ua-overlay'), null);
  assert.deepEqual(d.freezes.at(-1), ['usage-ask', false]);
  assert.equal(d.keyHandlers.length, 0, 'the key listener goes with it');
});

test('arrows move the choice like a radio group and wrap; other keys do nothing', () => {
  const d = load();
  d.U.maybeStart();
  d.key('ArrowLeft');
  assert.equal(cards(d).indexOf(onCard(d)), 2);
  d.key('ArrowDown');
  assert.equal(cards(d).indexOf(onCard(d)), 0);
  d.key('ArrowRight');
  assert.equal(d.document.activeElement, onCard(d));
  d.key('Escape');
  assert.equal(d.U.isOpen(), true, 'no "later": the question waits for an answer');
  d.document.querySelector('.ua-go').click();
  assert.deepEqual(d.saved, ['widgets']);
});

test('Enter confirms the card in focus; a held Enter does not', () => {
  const d = load();
  d.U.maybeStart();
  d.key('ArrowRight');
  d.key('ArrowRight');
  keyRepeat(d, 'Enter');
  assert.equal(d.U.isOpen(), true, 'a repeat is not a press');
  d.key('Enter');
  assert.deepEqual(d.saved, ['both']);
  assert.equal(d.U.isOpen(), false);
});

test('a tapped card keeps the focus for the arrows', () => {
  const d = load();
  d.U.maybeStart();
  cards(d)[2].click();
  assert.equal(d.document.activeElement, onCard(d));
});

test('wired after the screen question, never over the phone pairing guide, the tour only with a dashboard', () => {
  const settings = src('js/settings.js');
  const picker = src('js/surface-picker.js');
  assert.match(picker, /dispatchEvent\(new CustomEvent\('surface-picker-done', \{ detail: \{ phone: phone === true \} \}\)\)/);
  assert.match(picker, /finish\(\{ kind: 'both', monitor: '', label: '' \}, true\);/, 'the phone answer is marked');
  assert.match(settings, /addEventListener\('surface-picker-done', \(e\) => \{\n\s+if \(!\(e\.detail && e\.detail\.phone\)\) askUsage\(\);/);
  assert.match(settings, /askUsage\(\(mode\) => \{ if \(mode !== 'widgets'\) startTour\(\); \}\)/);
  const html = src('index.html');
  assert.ok(html.indexOf('js/usage-ask.js') > html.indexOf('js/surface-picker.js'));
  // Untrusted text never goes through innerHTML: only the fixed icons do.
  assert.doesNotMatch(SRC.replace(/head\.innerHTML = ICONS\[mode\];/, ''), /innerHTML/);
});

test('every text in all 11 languages', () => {
  const i18n = src('js/i18n.js');
  const ctx = {};
  vm.runInNewContext(i18n.slice(0, i18n.search(/^function /m)) + '\nthis.i18n = i18n;', ctx);
  const keys = ['usage_ask_title', 'usage_ask_sub', 'usage_ask_dash_body', 'usage_ask_widgets_body', 'usage_ask_both_body',
    'usage_ask_go', 'usage_ask_chosen', 'usage_ask_pick', 'xmenu_mode_dashboard', 'xmenu_mode_widgets', 'xmenu_mode_both'];
  for (const lang of ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl']) {
    for (const k of keys) assert.ok(ctx.i18n[lang][k], lang + ' ' + k);
    assert.match(ctx.i18n[lang].usage_ask_sub, /\{key\}/, lang);
  }
});
