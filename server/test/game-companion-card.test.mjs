import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import vm from 'node:vm';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// The real script on a small page: the card, the question box, a held keyboard.
function boot({ alertsWindow = false } = {}) {
  const els = {};
  const element = (id) => (els[id] ||= {
    id, hidden: id === 'gc-overlay', dataset: {}, textContent: '', value: '',
    classList: { add() {}, remove() {} },
    focus() { page.focused = id; },
    querySelector: (sel) => (sel === '.gc-card' ? element('gc-card') : null),
  });
  const page = { focused: '', looks: 0, holds: [], order: [], freeze: [], timers: [] };
  const ctx = {
    console,
    document: { getElementById: element, addEventListener() {} },
    requestAnimationFrame() {},
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: (fn) => { page.timers.push(fn); return page.timers.length; },
    clearTimeout: (id) => { page.timers[id - 1] = null; },
    t: (k) => k,
    aiFeatureEnabled: () => true,
    _aiHasKey: () => true,
    SERVER: '',
    lang: 'it',
    fetch: async (url) => {
      if (url === '/api/companion/insight') page.looks += 1;
      return { ok: true, json: async () => ({ text: 'Vai a nord.' }) };
    },
    ambientFreeze: (token, on) => page.freeze.push([token, on]),
    DialogFocus: {
      hold(root, opts) {
        page.holds.push({ root, opts });
        return () => page.order.push(els['gc-overlay'].hidden ? 'hidden' : 'let go');
      },
    },
  };
  ctx.window = ctx;
  if (alertsWindow) ctx.ScreenCompanion = {};
  vm.createContext(ctx);
  vm.runInContext(read('../js/game-companion.js'), ctx);
  return { card: ctx.GameCompanion, els, page, element };
}

const settle = () => new Promise((r) => setImmediate(r));
const runTimers = (page) => page.timers.splice(0).forEach((fn) => { if (fn) fn(); });

test('an empty question spends nothing: the caret goes to the box', async () => {
  const { card, page, element } = boot();
  card.openOverlay();
  element('gc-question').value = '   ';
  card.ask();
  await settle();
  assert.equal(page.looks, 0, 'a look can cost Sparks, it never starts by accident');
  assert.equal(page.focused, 'gc-question');
});

test('a question is one look, and the box empties', async () => {
  const { card, page, element } = boot();
  card.openOverlay();
  element('gc-question').value = ' dove vado? ';
  card.ask();
  await settle();
  assert.equal(page.looks, 1);
  assert.equal(element('gc-question').value, '');
});

test('on the dashboard the card holds the keyboard: Esc closes it, and it lets go first', () => {
  const { card, page, els, element } = boot();
  card.openOverlay();
  assert.equal(page.holds.length, 1);
  assert.equal(page.holds[0].root, element('gc-card'));
  page.holds[0].opts.onEsc();
  assert.equal(card.isOpen(), false);
  assert.deepEqual(page.order, ['let go'], 'before the card goes away');
  runTimers(page);
  assert.equal(els['gc-overlay'].hidden, true);
});

test('nothing paints under the frosted page while the card is up', () => {
  const { card, page } = boot();
  card.openOverlay();
  assert.deepEqual(page.freeze, [['game-companion', true]]);
  card.closeOverlay();
  assert.deepEqual(page.freeze.at(-1), ['game-companion', false]);
});

test('the alerts window never takes the keyboard from the game', () => {
  const { card, page } = boot({ alertsWindow: true });
  card.openOverlay();
  assert.equal(card.isOpen(), true);
  assert.equal(page.holds.length, 0);
});

test('opened again while it fades, the card stays', () => {
  const { card, page, els } = boot();
  card.openOverlay();
  card.closeOverlay();
  card.openOverlay();
  runTimers(page);
  assert.equal(els['gc-overlay'].hidden, false, 'the old hide must not take the new card away');
  assert.equal(card.isOpen(), true);
});

test('the card is a sheet: page blurred, one main key, the price with its spark', () => {
  const html = read('../index.html');
  const card = html.slice(html.indexOf('id="gc-overlay"'), html.indexOf('<!-- Perspective neon grid'));
  assert.match(card, /class="gc-card" tabindex="-1"/);
  assert.match(card, /<div class="gc-keys">\s*<p class="gc-cost"[^>]*>.*<\/p>\s*<button class="gc-analyze"/, 'the main key comes last');
  assert.match(card, /class="gc-cost-spark" data-xspark/);
  assert.doesNotMatch(card.slice(card.indexOf('gc-analyze')), /<svg/, 'words on the key, no picture');
  const css = read('../components/GameCompanion/GameCompanion.css');
  assert.doesNotMatch(css, /gradient/);
  assert.doesNotMatch(css, /var\(--surface-alt\)/, 'a grey wash hid the dashboard');
  assert.match(css, /\.gc-card \{[^}]*max-height: calc\(100dvh - 36px\);/);
  assert.match(css, /\.gc-reply \{[^}]*overflow-y: auto;/);
  const sheets = read('../styles/liquid-sheets.css');
  assert.match(sheets, /\[data-screen-alerts\] :is\(\.call-overlay, \.gc-overlay\) \{ background: none;/, 'no scrim over a game');
  assert.doesNotMatch(sheets.slice(sheets.indexOf(':root[data-style="liquid"] .gc-pill {')).split('}')[0], /backdrop-filter/, 'the game would pay for a blur');
});
