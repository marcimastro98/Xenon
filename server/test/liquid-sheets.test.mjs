// The glass of the windows that ask for a moment. A dialog over a blurred page must not
// blur again (the overlay is a backdrop root, a second blur samples nothing), a slow path
// must never be left with a thin fill and no blur behind words, and the other skins keep
// their own lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync as readFileSyncRaw } from 'node:fs';
// A Windows checkout (core.autocrlf) has CRLF; everything below matches on LF.
const read = (rel) => readFileSyncRaw(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const CSS = read('../styles/liquid-sheets.css').replace(/\/\*[\s\S]*?\*\//g, '');
const SKIN = ':root[data-style="liquid"]';

// Innermost rules, so what sits in a media query counts like the rest.
function rules(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
}

// Split a selector list on its own commas, leaving those inside :is() and :not().
function split(list) {
  const out = [];
  let depth = 0;
  let part = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(part.trim()); part = ''; } else part += ch;
  }
  out.push(part.trim());
  return out;
}

function bodyOf(selector) {
  const found = rules(CSS).find((rule) => rule.selector === selector);
  assert.ok(found, `no rule for ${selector}`);
  return found.body;
}

test('every rule sits behind the Liquid skin', () => {
  for (const { selector } of rules(CSS)) {
    for (const one of split(selector)) assert.ok(one.startsWith(SKIN), one);
  }
});

test('every token it reads is declared, for the alerts window too', () => {
  const declared = new Set([...CSS.matchAll(/(--sheet-[\w-]+):/g)].map((m) => m[1]));
  for (const [, name] of CSS.matchAll(/var\((--sheet-[\w-]+)/g)) assert.ok(declared.has(name), name);
});

test('it reads no token of the chrome: liquid-chrome.css is not in the alerts window', () => {
  assert.doesNotMatch(CSS, /var\(--lg-/);
  assert.doesNotMatch(read('../screen-alerts.html'), /liquid-chrome\.css/);
});

test('the scrim blurs once and the sheet is fill and rim', () => {
  assert.match(bodyOf(`${SKIN} :is(.upd-overlay, .rn-overlay, .perf-sheet-overlay, .weather-overlay, .day-modal-backdrop, .ai-pc-confirm, .picker-overlay, .call-overlay, .gc-overlay, .diskw-advisor-modal, .ask-overlay, .xm-scrim, .widget-palette-overlay, .deck-ed-backdrop, .deck-mix-backdrop, .deck-style-modal, .xfer-sheet-backdrop, .preset-modal-overlay:not(.cst-overlay, .capg-overlay))`), /backdrop-filter: var\(--sheet-scrim-blur\)/);
  const sheet = bodyOf(`${SKIN} :is(.upd-card, .rn-card, .perf-sheet, .weather-panel, .day-modal-card, .ai-pc-card, .picker-panel, .call-card, .gc-card, .diskw-advisor-dialog, .ask-sheet, .xm-frame, .widget-palette-modal, .deck-ed-modal, .deck-mix-modal, .deck-style-dialog, .deck-asw, .xfer-sheet, .preset-modal:not(.cst, .cgal-modal))`);
  assert.doesNotMatch(sheet, /backdrop-filter/);
  assert.match(sheet, /var\(--sheet-fill\)/);
  // The base rule of this sheet has a blur of its own, for the other skins.
  assert.match(bodyOf(`${SKIN} :is(.perf-sheet, .xm-frame)`), /backdrop-filter: none/);
});

test('the Store and the Gallery keep their own frame', () => {
  const taken = rules(CSS).filter((rule) => /\.preset-modal/.test(rule.selector));
  assert.ok(taken.length > 3);
  for (const rule of taken) {
    for (const part of split(rule.selector)) {
      assert.match(part, /\.preset-modal(-overlay:not\(\.cst-overlay, \.capg-overlay\)|:not\(\.cst, \.cgal-modal\))/, part);
    }
  }
});

test('a key that destroys is a red word on the well, whatever red the theme picks', () => {
  assert.match(bodyOf(':root[data-style="liquid"] .preset-modal:not(.cst, .cgal-modal) .settings-btn.danger'), /color: var\(--color-danger\)/);
});

test('a card over the live page blurs by itself', () => {
  const card = rules(CSS).find((rule) => rule.selector.includes('.bm-card') && /backdrop-filter/.test(rule.body));
  assert.match(card.body, /backdrop-filter: var\(--sheet-blur\)/);
});

test('the slow paths leave no thin fill without a blur', () => {
  const low = bodyOf(`${SKIN} body.low-power-gpu`);
  const solid = bodyOf(`${SKIN} body`);   // prefers-reduced-transparency
  for (const path of [low, solid]) {
    assert.match(path, /--sheet-blur: none/);
    assert.match(path, /--sheet-scrim-blur: none/);
  }
  assert.match(low, /--sheet-fill: rgba\(var\(--panel-rgb\), 0\.97\)/);
  assert.match(low, /--sheet-card: rgba\(var\(--panel-rgb\), 0\.97\)/);
  assert.match(solid, /--sheet-fill: rgb\(var\(--panel-rgb\)\)/);
  assert.match(solid, /--sheet-card: rgb\(var\(--panel-rgb\)\)/);
});

test('it loads last of the Liquid sheets, and in the alerts window', () => {
  const html = read('../index.html');
  const at = (name) => {
    const found = html.indexOf(name);
    assert.notEqual(found, -1, `index.html does not load ${name}`);
    return found;
  };
  assert.ok(at('styles/liquid-edit.css') < at('styles/liquid-sheets.css'));
  assert.match(read('../screen-alerts.html'), /styles\/liquid-sheets\.css/);
});

test('a list that opens over a form is solid, its search box too, and the chosen row is not green', () => {
  const list = bodyOf(`${SKIN} :is(.cs-panel, .deck-pmenu, .ai-attach-menu)`);
  assert.match(list, /linear-gradient\(rgb\(var\(--panel-rgb\)\) 0 0\)/);
  assert.match(list, /backdrop-filter: none/);
  assert.match(bodyOf(`${SKIN} .cs-search-wrap`), /background: rgb\(var\(--panel-rgb\)\)/);
  const chosen = bodyOf(`${SKIN} :is(.cs-option.cs-selected, .cs-option.cs-selected.cs-active, .deck-pmenu-row.active)`);
  assert.match(chosen, /var\(--sheet-well-hover\)/);
  assert.doesNotMatch(chosen, /accent|--sheet-main/);
  // Every skin: the search row takes the panel's own fill, never the see-through --panel.
  const base = read('../components/CustomSelect/CustomSelect.css');
  const wrap = base.slice(base.indexOf('.cs-search-wrap {'), base.indexOf('}', base.indexOf('.cs-search-wrap {')));
  assert.match(wrap, /background: inherit;/);
  assert.doesNotMatch(wrap, /var\(--panel/);
});
