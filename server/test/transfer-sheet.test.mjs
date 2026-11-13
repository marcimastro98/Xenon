// Send to PC, the sheet the phone dock opens. It is the phone's main way to hand a file over,
// so what has to stay true is pinned here on the real module:
//  1. One step at a time: Esc and the phone's Back close the help first, the sheet after it.
//  2. Back never leaves Xenon, and the sheet never spends a second history step of its own.
//  3. A sheet that goes lets go of the keyboard and gives the focus back.
//  4. One main key, last, as on every sheet. The tile keeps its own order.
//  5. A row's age is written in the app's language.
//  6. On a phone the sheet goes when pulled down by its bar, and comes back when let go short.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeDom, windowKeys } from './mini-dom.mjs';
import { appStringsSource, appStrings, APP_LANGS } from './i18n-source.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const SRC = read('../js/transfer-widget.js');
const CSS = read('../components/TransferWidget/TransferWidget.css');
const LIQUID = read('../styles/liquid-sheets.css');
const I18N = appStringsSource();

// A history that behaves: back() spends the entry and tells the page, as a browser does.
function fakeHistory(fire) {
  const stack = [null];
  const log = { pushes: 0, backs: 0 };
  return {
    log,
    get state() { return stack[stack.length - 1]; },
    get length() { return stack.length; },
    pushState(state) { log.pushes += 1; stack.push(state); },
    back() { log.backs += 1; this.pressBack(); },
    // The phone's own key: the same pop, with nothing of ours asking for it.
    pressBack() { if (stack.length > 1) stack.pop(); fire(); },
  };
}

function rig({ lang = 'en', wide = false } = {}) {
  const { document, mkEl } = makeDom();
  const window = {};
  const keys = windowKeys(window);
  const onKeyAdd = window.addEventListener;
  const pops = [];
  window.addEventListener = (type, fn, opts) => {
    if (type === 'popstate') pops.push(fn);
    else onKeyAdd(type, fn, opts);
  };
  const history = fakeHistory(() => pops.forEach((fn) => fn()));
  const freezes = [];
  window.ambientFreeze = (_token, on) => freezes.push(on);
  document.readyState = 'complete';
  document.documentElement.lang = lang;
  // The sheet stands on the bottom edge below 700px, as the CSS says.
  window.matchMedia = (q) => ({ matches: q === '(max-width: 699.98px)' && !wide });
  const clock = { t: null };
  class ClockDate extends Date { static now() { return clock.t ?? super.now(); } }
  const box = {
    window, document, history, Intl, Date: ClockDate,
    navigator: { userAgent: 'Android' },
    setTimeout: () => 0,
    clearTimeout: () => {},
    apiJson: async () => null,
    formatBytes: (n) => `${n} B`,
    makeEl: (tag, cls, text) => {
      const n = mkEl(tag);
      if (cls) n.className = cls;
      if (text !== undefined && text !== null) n.textContent = text;
      return n;
    },
  };
  vm.runInNewContext(read('../js/dialog-focus.js'), box);
  vm.runInNewContext(SRC, box);
  const widget = window.TransferWidget;
  const press = (key) => {
    const ev = { key, preventDefault() {}, stopPropagation() {} };
    keys.slice().forEach((fn) => fn(ev));
  };
  const sheet = () => document.querySelector('.xfer-sheet-backdrop');
  const panel = () => document.querySelector('.xfer-sheet');
  const help = () => panel().querySelector('.xfer-help');
  const helpKey = () => panel().querySelector('.xfer-sheet-bar .xfer-help-btn');
  return { document, window, history, keys, freezes, widget, press, sheet, panel, help, helpKey, mkEl, clock };
}

test('Esc closes the help first and the sheet after it', () => {
  const r = rig();
  r.widget.openSheet();
  r.helpKey().click();
  assert.equal(r.help().hidden, false);

  r.press('Escape');
  assert.equal(r.help().hidden, true, 'the help goes first');
  assert.ok(r.sheet(), 'and the sheet stays');
  assert.equal(r.helpKey().getAttribute('aria-expanded'), 'false');

  r.press('Escape');
  assert.equal(r.sheet(), null);
});

test('Back closes the sheet and spends no second step', () => {
  const r = rig();
  r.widget.openSheet();
  assert.equal(r.history.log.pushes, 1, 'one step for Back to land on');

  r.history.pressBack();
  assert.equal(r.sheet(), null);
  assert.equal(r.history.log.backs, 0, 'Back already popped the entry: another pop would leave Xenon');
  assert.equal(r.history.length, 1);
});

test('Back closes the help and keeps a step for the sheet left open', () => {
  const r = rig();
  r.widget.openSheet();
  r.helpKey().click();

  r.history.pressBack();
  assert.equal(r.help().hidden, true);
  assert.ok(r.sheet());
  assert.equal(r.history.length, 2, 'a second Back must still land on the sheet');

  r.history.pressBack();
  assert.equal(r.sheet(), null);
  assert.equal(r.history.length, 1);
});

test('the X and a press outside give the history step back', () => {
  for (const leave of [
    (r) => r.panel().querySelectorAll('.xfer-sheet-bar .xfer-icon').at(-1).click(),
    (r) => r.sheet()._handlers.click.forEach((fn) => fn({ target: r.sheet() })),
  ]) {
    const r = rig();
    r.widget.openSheet();
    leave(r);
    assert.equal(r.sheet(), null);
    assert.equal(r.history.log.backs, 1);
    assert.equal(r.history.length, 1, 'no step left behind for Back to land on nothing');
  }
});

test('a press inside the sheet is not a press outside', () => {
  const r = rig();
  r.widget.openSheet();
  r.sheet()._handlers.click.forEach((fn) => fn({ target: r.panel() }));
  assert.ok(r.sheet());
});

test('a sheet that goes lets go of the keyboard and gives the focus back', () => {
  const r = rig();
  const opener = r.mkEl('button');
  r.document.body.appendChild(opener);
  opener.focus();

  r.widget.openSheet();
  assert.equal(r.document.activeElement, r.panel(), 'no key holds the focus when it opens');
  assert.equal(r.keys.length, 1);
  assert.deepEqual(r.freezes, [true]);

  r.press('Escape');
  assert.equal(r.keys.length, 0, 'a root gone without letting go traps Tab and Esc for good');
  assert.equal(r.document.activeElement, opener);
  assert.deepEqual(r.freezes, [true, false]);
});

test('it can open again after every way out', () => {
  const r = rig();
  r.widget.openSheet();
  r.press('Escape');
  r.widget.openSheet();
  r.history.pressBack();
  r.widget.openSheet();
  assert.ok(r.sheet());
  assert.equal(r.keys.length, 1);
  assert.equal(r.history.length, 2);
});

test('the sheet is a dialog, and a second open does not stack one', () => {
  const r = rig();
  r.widget.openSheet();
  r.widget.openSheet();
  assert.equal(r.document.querySelectorAll('.xfer-sheet').length, 1);
  assert.equal(r.history.log.pushes, 1);
  assert.equal(r.panel().getAttribute('role'), 'dialog');
  assert.equal(r.panel().getAttribute('aria-modal'), 'true');
  assert.ok(r.panel().getAttribute('aria-label'));
});

test('the two keys sit in the foot, the main one last', () => {
  const r = rig();
  r.widget.openSheet();
  const foot = r.panel().querySelector('.xfer-sheet-foot');
  const row = foot.querySelector('.xfer-actions');
  assert.equal(row.children.length, 2);
  assert.ok(row.children[1].className.includes('xfer-btn-primary'), 'one main key, on the right');
  assert.equal(r.panel().querySelector('.transfer-widget-mount .xfer-actions'), null);
  // Only the sheet moves them: a tile keeps the row it was built with.
  assert.match(SRC, /actions\.append\(bPhotos, bFiles\);/);
});

test('the file inputs are no stops on the way through the sheet', () => {
  const r = rig();
  r.widget.openSheet();
  const inputs = r.panel().querySelectorAll('.xfer-input');
  assert.equal(inputs.length, 2);
  inputs.forEach((input) => assert.equal(input.tabIndex, -1));
});

test('a row says how old it is in the language of the app', () => {
  const day = 86400000;
  const meta = (lang) => {
    const r = rig({ lang });
    r.widget.openSheet();
    r.widget.onState({ enabled: true, pending: [], items: [{ id: 'a', name: 'a.png', size: 10, at: Date.now() - day - 1000, ext: '.png' }] });
    return r.panel().querySelector('.xfer-meta').textContent;
  };
  assert.match(meta('en'), /1 day/);
  assert.match(meta('it'), /1 giorno/);
  assert.doesNotMatch(meta('en'), /\bg\b/, 'the old unit was Italian in every language');
});

test('the how-to names the key as the key reads, in every language', () => {
  const all = (key) => APP_LANGS.map((lang) => appStrings()[lang][key]).filter((text) => typeof text === 'string');
  const names = all('xfer_pick_photos');
  const lines = all('xfer_help_to_pc_3');
  assert.equal(names.length, 11);
  assert.equal(lines.length, 11);
  names.forEach((name, at) => assert.ok(lines[at].includes(name), `${name} is not in: ${lines[at]}`));
});

test('promos and the screensaver wait for the sheet', () => {
  assert.match(read('../js/ambient-mode.js'), /\.xfer-sheet-backdrop/);
  assert.match(read('../js/interrupt-queue.js'), /'\.xfer-sheet-backdrop'/);
});

test('the sheet is measured against the page, not against vh', () => {
  // A phone's vh counts the browser bar, so a sheet in vh ends under it, keys included.
  const sheetRule = CSS.slice(CSS.indexOf('\n.xfer-sheet {'), CSS.indexOf('}', CSS.indexOf('\n.xfer-sheet {')));
  assert.match(sheetRule, /max-height: min\(88%, 720px\)/);
  assert.doesNotMatch(sheetRule, /\dvh/);
});

test('a phone on its side scrolls the list and the notes together', () => {
  const r = rig();
  r.widget.openSheet();
  const body = r.panel().querySelector('.xfer-sheet-body');
  assert.ok(body.querySelector('.transfer-widget-mount') && body.querySelector('.xfer-notes'));
  assert.equal(body.querySelector('.xfer-sheet-foot'), null, 'the keys stay on screen');
  const short = CSS.slice(CSS.indexOf('@media (max-height: 520px)'));
  assert.match(short, /\.xfer-sheet-body \{ overflow-y: auto; \}/);
  assert.match(short, /\.xfer-sheet \.xfer-list,\s+\.xfer-sheet \.xfer-help \{ overflow: visible; \}/);
});

test('every skin finds the same sheet', () => {
  assert.match(CSS, /\.xfer-sheet \.xfer-zone \{[^}]*border: 0;/, 'the zone keeps the edge of the title and the notes');
  assert.match(CSS, /\.xfer-sheet \.xfer-head \{ display: none; \}/);
  assert.match(LIQUID, /\.xfer-sheet-backdrop/);
  assert.match(read('../styles/theme-contract.css'), /\.xfer-sheet\b/);
  assert.match(read('../styles/themes-comic.css'), /\.xfer-sheet\b/);
});

// A finger on the bar: down at y 100, then each [dy, ms] step, then up (or cancelled).
function pull(r, steps, { on, end = 'pointerup' } = {}) {
  r.clock.t ??= 1_000_000;
  const bar = r.panel().querySelector('.xfer-sheet-bar');
  const fire = (type, ev) => (bar._handlers[type] || []).forEach((fn) => fn({ button: 0, pointerId: 1, target: on || bar, ...ev }));
  fire('pointerdown', { clientY: 100 });
  for (const [dy, ms] of steps) { r.clock.t += ms; fire('pointermove', { clientY: 100 + dy }); }
  fire(end, {});
}

test('pulled far enough down its bar, the sheet goes and gives the history step back', () => {
  const r = rig();
  r.widget.openSheet();
  r.panel()._rect.height = 600;
  pull(r, [[60, 100], [120, 100], [170, 100]]);
  assert.equal(r.sheet(), null);
  assert.equal(r.history.length, 1, 'the same way out as the X');
});

test('let go short, the sheet springs back', () => {
  const r = rig();
  r.widget.openSheet();
  r.panel()._rect.height = 600;
  pull(r, [[40, 100], [80, 100]]);
  assert.ok(r.sheet());
  assert.equal(r.panel().style.getPropertyValue('--xfer-pull'), '', 'back where it was');
  assert.equal(r.panel().classList.contains('is-pulled'), false, 'the spring is on again');
});

test('a quick flick closes from a short pull, a jitter does not', () => {
  const r = rig();
  r.widget.openSheet();
  r.panel()._rect.height = 600;
  pull(r, [[20, 16], [70, 16]]);
  assert.equal(r.sheet(), null);

  const q = rig();
  q.widget.openSheet();
  q.panel()._rect.height = 600;
  pull(q, [[12, 8]]);
  assert.ok(q.sheet(), 'twelve pixels is a tap that moved');

  // Quick down, then held still before lifting: put back, not thrown.
  const h = rig();
  h.widget.openSheet();
  h.panel()._rect.height = 600;
  const bar = h.panel().querySelector('.xfer-sheet-bar');
  const fire = (type, ev) => bar._handlers[type].forEach((fn) => fn({ button: 0, pointerId: 1, target: bar, ...ev }));
  h.clock.t = 1_000_000;
  fire('pointerdown', { clientY: 100 });
  h.clock.t += 16; fire('pointermove', { clientY: 170 });
  h.clock.t += 400; fire('pointerup', {});
  assert.ok(h.sheet(), 'a finger that stopped threw nothing');
});

test('the sheet follows the finger down, never up', () => {
  const r = rig();
  r.widget.openSheet();
  const bar = r.panel().querySelector('.xfer-sheet-bar');
  const fire = (type, y) => bar._handlers[type].forEach((fn) => fn({ button: 0, pointerId: 1, target: bar, clientY: y }));
  fire('pointerdown', 100);
  fire('pointermove', 150);
  assert.equal(r.panel().style.getPropertyValue('--xfer-pull'), '50px');
  assert.ok(r.panel().classList.contains('is-pulled'), 'no spring while the finger holds it');
  fire('pointermove', 40);
  assert.equal(r.panel().style.getPropertyValue('--xfer-pull'), '0px');
});

test('a cancelled pull brings the sheet back, the keys on the bar stay keys, a wide screen has no pull', () => {
  const r = rig();
  r.widget.openSheet();
  r.panel()._rect.height = 600;
  pull(r, [[300, 100]], { end: 'pointercancel' });
  assert.ok(r.sheet(), 'the system took the finger: never away');

  pull(r, [[300, 100]], { on: r.helpKey() });
  assert.ok(r.sheet(), 'a press on the ? is the ?');

  const w = rig({ wide: true });
  w.widget.openSheet();
  w.panel()._rect.height = 600;
  pull(w, [[300, 100]]);
  assert.ok(w.sheet(), 'the centred dialog has no edge to go to');
});

test('the pull, the grabber and the spring live only where the sheet stands on the edge', () => {
  const block = CSS.slice(CSS.indexOf('Pulled down by its bar'), CSS.indexOf('@media (min-width: 700px)'));
  assert.match(block, /@media \(max-width: 699\.98px\) \{[\s\S]*translateY\(var\(--xfer-pull, 0px\)\)/);
  assert.match(block, /\.xfer-sheet\.is-pulled \{ transition: none; \}/);
  assert.match(block, /\.xfer-sheet-bar \{ touch-action: none; \}/, 'the page must not scroll under the pull');
  assert.match(block, /prefers-reduced-motion: reduce\) \{\s*\.xfer-sheet \{ transition: none; \}/);
  assert.match(SRC, /matchMedia\('\(max-width: 699\.98px\)'\)/, 'JS and CSS use one breakpoint');
});
