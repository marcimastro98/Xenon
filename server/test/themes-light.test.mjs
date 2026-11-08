import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../styles/themes-light.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
const accentBlock = css.slice(css.indexOf('/* ── The accent as text'));
const floating = css.slice(css.indexOf('/* ── Floating surfaces'), css.indexOf('/* ── Store tiers as text'));

test('the accent list stays last, so regenerating it never eats a hand rule', () => {
  assert.ok(accentBlock.length > 0);
  assert.equal(accentBlock.indexOf('/* ──', 10), -1, 'no other block after the accent list');
});

test('green text across the app takes the ink colour on paper', () => {
  for (const selector of ['.settings-nav-btn.active', '.cw-run-badge']) {
    assert.ok(accentBlock.includes(selector), selector);
  }
  assert.match(accentBlock, /color: var\(--accent-ink, var\(--accent\)\);/);
});

test('text over a dark picture keeps its own colour', () => {
  assert.ok(!/\.cgal-new\b/.test(rules));
  assert.ok(!/\.cgal-tier\b/.test(rules), 'the chip over a picture is not repainted');
});

test('a danger button stays red: the generic button rule leaves it alone', () => {
  assert.ok(css.includes('.settings-btn:not(.danger)'));
  assert.ok(!/\.settings-btn\s*[,{]/.test(css), 'no rule on every settings button');
});

test('the update and call windows are paper, not a fixed dark gradient', () => {
  for (const selector of ['.upd-card', '.call-card']) {
    assert.ok(floating.includes(`:root[data-appearance="light"] ${selector}`), selector);
  }
  assert.match(floating, /var\(--surface\);\n\s*border-color: var\(--lt-border\);/);
});

test('the Deck windows read their colours from the same tokens on light', () => {
  assert.match(css, /:root\[data-appearance="light"\] :is\(\.deck-ed-modal, \.deck-mix-modal, \.deck-style-dialog, \.deck-asw\) \{\n  --ded-well: var\(--control-bg\);/);
  assert.ok(!floating.includes('.deck-ed-modal'), 'no second paint over the plate');
});

test('editor controls use :where, so active and primary variants still win', () => {
  for (const selector of ['.deck-ed-btn', '.upd-btn', '.call-btn']) {
    assert.ok(floating.includes(`:where(:root[data-appearance="light"]) ${selector}`), selector);
    assert.ok(!floating.includes(`:root[data-appearance="light"] ${selector},`), `${selector} has no heavy rule`);
  }
});

test('the key preview stays dark, so its names keep light text', () => {
  assert.match(floating, /\.deck-ed-preview-root \{ --text: #e8ebf2; --text-dim: #9aa1b1; \}/);
});
