// The thank-you page (docs/thanks.html) on the home's system: Sofia Sans, no
// tracked monospace caps, prices that name their currency, plain step numbers,
// no pulsing dot, controls tall enough for a finger, and every site language
// in the menu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const page = readFileSync(join(root, 'docs', 'thanks.html'), 'utf8');
const css = page.slice(page.indexOf('<style>'), page.indexOf('</style>'));
const rules = (selector) => {
  const out = [];
  const re = new RegExp('(?:^|[\\n}])\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
  let m;
  while ((m = re.exec(css))) out.push(m[1]);
  assert.ok(out.length, `no rule ${selector}`);
  return out.join(';');
};

test('the page keeps the site fonts', () => {
  assert.doesNotMatch(css, /'Inter'|JetBrains Mono/);
});

test('no tracked monospace caps anywhere on the page', () => {
  assert.doesNotMatch(css, /text-transform: uppercase/);
  assert.doesNotMatch(css, /letter-spacing: \.\d/);
  for (const sel of ['.eyebrow', '.opt .price', '.hint', '.away .away-status']) {
    assert.doesNotMatch(rules(sel), /var\(--mono\)/, sel);
  }
});

test('steps are numbered 1, 2, 3, not 01, 02, 03', () => {
  assert.doesNotMatch(css, /decimal-leading-zero/);
});

test('every price names its currency', () => {
  assert.doesNotMatch(page, /'\$\d|"\$\d|\$\d|\d \$|\$\?/);
  assert.match(page, /price: '25 USD'/);
});

test('nothing pulses', () => {
  assert.doesNotMatch(css, /@keyframes|animation:/);
  assert.doesNotMatch(page, /class="dot"/);
});

test('one card look: a 1px rule, no fill', () => {
  assert.match(rules('.card'), /background: none; border: 1px solid var\(--rule\)/);
  assert.doesNotMatch(rules('.opt'), /background: var\(--g-0\)/);
});

test('the steps sit right under the thanks, with no gap from the taller card', () => {
  assert.match(rules('.hero'), /grid-template-rows: auto 1fr/);
});

test('the payment switch is tall enough to tap', () => {
  assert.match(rules('.seg button'), /min-height: 44px/);
});

test('the language menu lists every site language', () => {
  const menu = page.match(/<div class="lang-menu"[^>]*>([\s\S]*?)<\/div>/)[1];
  for (const l of ['en', 'it', 'es', 'fr', 'ja', 'ko', 'zh']) assert.match(menu, new RegExp(`data-lang="${l}"`), l);
});

test('no rules left for the old header', () => {
  assert.doesNotMatch(css, /header\.top|\.navbtn|\.logo \{|\.back \{|\.nat \{/);
});
