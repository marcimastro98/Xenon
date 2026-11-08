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
  for (const sel of ['.next h2', '.opt .price', '.hint', '.away .away-status']) {
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

test('one card look: flat on a step of the paper, each choice a step back', () => {
  assert.match(rules('.card'), /background: var\(--g-1\)/);
  assert.doesNotMatch(rules('.card'), /border:/);
  assert.match(rules('.opt'), /background: var\(--g-0\)/);
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

test('a drop picture that does not load leaves the language menu working', () => {
  // The caption is rewritten on every language change, so the figure must not go while the
  // page still thinks it has a drop: the throw would stop the change half way.
  assert.match(page, /img\.onerror = \(\) => \{ drop = null; fig\.remove\(\); \};/);
});

test('the pack on the thanks page shows whole, in its own shape', () => {
  assert.doesNotMatch(rules('#drop img'), /aspect-ratio|object-fit/);
  assert.match(page, /id="drop-img" alt="" width="1600" height="900"/);
});
