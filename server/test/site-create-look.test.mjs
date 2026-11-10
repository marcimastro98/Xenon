// The creator guide (docs/create/index.html) on the site's system: it opens on a
// sheet, its contents sit beside the reading column like the list beside the other
// guides, guide.css draws the text, code sits on the page's own greys in both
// themes, and nothing is left of the old top bar or of the old way to publish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const page = readFileSync(join(root, 'docs', 'create', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
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
  assert.doesNotMatch(css, /rgba\(/);
});

test('the shared styles load first, so the page only adds to them', () => {
  const [site, guide, own] = ['href="/site.css"', 'href="/guide.css"', '<style>'].map((s) => page.indexOf(s));
  assert.ok(site > 0 && site < guide && guide < own);
  for (const sel of ['*', 'body', 'p', 'h3', 'ul, ol', 'li', 'table', '.note', '.foot-help']) {
    assert.throws(() => rules(sel), /no rule/, `${sel} belongs to guide.css`);
  }
});

test('no gradients, no fake window dots, no soft shadows', () => {
  assert.doesNotMatch(css, /gradient\(/);
  assert.doesNotMatch(page, /<span class="dot"><\/span>/);
  assert.doesNotMatch(css, /box-shadow: \d+px \d+px/);
});

test('the ways in are flat: a step of the paper, 10px corners, no line', () => {
  const r = rules('.path');
  assert.match(r, /background: var\(--g-1\)/);
  assert.match(r, /border-radius: var\(--r-2\)/);
  assert.doesNotMatch(r, /border:/);
  assert.doesNotMatch(rules('.code-bar'), /border:/);
  assert.doesNotMatch(rules('.code pre'), /border:/);
});

test('a code block inside a card steps back to the paper', () => {
  assert.match(rules('.card'), /--code-bg: var\(--g-0\)/);
  assert.match(rules('.code-bar'), /var\(--code-bg, var\(--g-1\)\)/);
  assert.match(rules('.code pre'), /var\(--code-bg, var\(--g-1\)\)/);
});

test('a share code wraps in its box instead of running off to the side', () => {
  assert.match(rules('.code.oneline pre code'), /white-space: pre-wrap/);
  assert.match(rules('.code.oneline pre code'), /word-break: break-all/);
});

test('a code block\'s name is in the text face', () => {
  assert.doesNotMatch(rules('.code-bar'), /var\(--mono\)/);
  assert.doesNotMatch(rules('.code-bar .fname'), /letter-spacing: 0\.\d/);
});

test('steps are plain numbers, not filled badges', () => {
  assert.doesNotMatch(rules('.steps > li::before'), /background/);
});

test('Copy is big enough to hit, and bigger on a touchscreen', () => {
  assert.match(rules('.copy-btn'), /min-height: 36px/);
  assert.match(css, /@media \(pointer: coarse\) \{[^@]*\.copy-btn \{ min-height: 44px;/);
  assert.match(rules('.copy-btn.done'), /background: var\(--main\); color: var\(--main-ink\)/);
});

test('the search field keeps the shared focus ring and a visible edge', () => {
  assert.doesNotMatch(css, /\.gs-input:focus \{/);
  assert.match(rules('.gs-input'), /border: 1px solid var\(--bone-2\)/);
});

test('the contents sit beside the text and stay reachable on a phone', () => {
  assert.match(page, /<main>\n<section class="pg" aria-labelledby="pg-h">/);
  assert.match(page, /<div class="pg-body shell">\n/);
  assert.match(rules('.shell'), /grid-template-columns: 264px minmax\(0, var\(--maxw\)\)/);
  assert.match(page, /<div class="guide-bar" id="guideBar">/);
  assert.match(page, /const main = doc\.querySelector\('\.content'\);/);
  assert.match(page, /\[sheet, main, header, footer\]\.forEach/, 'what is behind the phone sheet is out of reach');
  assert.match(page, /main\.querySelectorAll\('\.tablewrap table'\)/);
});

test('publishing is told as it works: the site form, then a person', () => {
  const publish = page.slice(page.indexOf('<section id="publish">'), page.indexOf('<section id="help"'));
  assert.match(publish, /href="\.\.\/submit\/"/);
  assert.match(publish, /<b>Share code<\/b>/);
  assert.doesNotMatch(publish, /GitHub|merged|hidden backend/);
});

test('the guide uses the English words of the app', () => {
  assert.doesNotMatch(page, /Personalizza|Fumetto/);
});

test('no rules left for the old top bar or the old page', () => {
  assert.doesNotMatch(css, /\.topbar|\.tb-link|\.tb-cta|\.menu-btn|\.brand \{|\.mono \{|\.hero-h|\.crumbs|\.xh \{|\.kinds|\.table-wrap|\.no-rule/);
  assert.doesNotMatch(page, /class="(inline|muted|note safe|hero-h|table-wrap|kinds)"/);
});
