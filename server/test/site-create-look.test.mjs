// The creator guide (docs/create/index.html) on the home's system: cards are
// the home card, code sits on the page's own greys in both themes, file names
// in the text face, no fake window dots, no gradients, plain step numbers,
// kinds as small outline tags, a Copy button big enough to hit, and no rules
// left over from the old top bar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const page = readFileSync(join(root, 'docs', 'create', 'index.html'), 'utf8');
const css = page.slice(page.indexOf('<style>'), page.indexOf('</style>'));
const rules = (selector) => {
  const out = [];
  const re = new RegExp('(?:^|[\\n}])\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
  let m;
  while ((m = re.exec(css))) out.push(m[1]);
  assert.ok(out.length, `no rule ${selector}`);
  return out.join(';');
};

test('the page keeps the site fonts and the site greys', () => {
  assert.doesNotMatch(css, /JetBrains Mono/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,6}\b/i, 'a hand-written colour');
  assert.doesNotMatch(css, /rgba\(240, 243, 241/);
});

test('no gradients and no fake window dots', () => {
  assert.doesNotMatch(css, /gradient\(/);
  assert.doesNotMatch(page, /<span class="dot"><\/span>/);
});

test('cards, notes and the three ways are the home card: a 1px rule, no fill', () => {
  for (const sel of ['.card', '.mini', '.path', '.note']) {
    const r = rules(sel);
    assert.match(r, /border: 1px solid var\(--rule\)/, sel);
    assert.match(r, /background: none/, sel);
  }
});

test('a code block\'s name is in the text face', () => {
  assert.doesNotMatch(rules('.code-bar'), /var\(--mono\)/);
  assert.doesNotMatch(rules('.code-bar .fname'), /letter-spacing: 0\.\d/);
});

test('steps are plain numbers, not filled badges', () => {
  assert.doesNotMatch(rules('.steps > li::before'), /background/);
});

test('the kinds of creation are small outline tags', () => {
  const r = rules('.kinds span');
  assert.match(r, /padding: 2px 6px/);
  assert.doesNotMatch(r, /background/);
});

test('Copy is big enough to hit, and bigger on a touchscreen', () => {
  assert.match(rules('.copy-btn'), /min-height: 36px/);
  assert.match(css, /@media \(pointer: coarse\) \{[^@]*\.copy-btn \{ min-height: 44px;/);
});

test('no rules left for the old top bar', () => {
  assert.doesNotMatch(css, /\.topbar|\.tb-link|\.tb-cta|\.menu-btn|\.brand \{|\.mono \{|\.hero-h \.g/);
});
