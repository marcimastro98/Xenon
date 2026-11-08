// Links people tap on the text pages are 44px tall rows, not 26px lines of
// text: the section links under a guide's title, a release's entries (the
// whole row opens it, without !important), and the two links on the share page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const rule = (css, selector) => {
  const at = css.indexOf(selector + ' {');
  assert.ok(at >= 0, `no rule ${selector}`);
  return css.slice(at, css.indexOf('}', at));
};

test('a guide\'s section links are 44px rows', () => {
  assert.match(rule(read('docs', 'site.css'), '.jump a'), /min-height: 44px/);
});

test('a release entry opens from its whole row, with no !important', () => {
  for (const src of [read('tools', 'build-releases.mjs'), read('docs', 'releases.html')]) {
    assert.match(rule(src, '.rel-items details > summary'), /padding: 12px 0/);
    assert.doesNotMatch(src, /\.rel-one \{[^}]*!important/);
  }
});

test('the theme switch on every page is 44px and speaks every site language', () => {
  const js = read('docs', 'theme.js');
  assert.match(js, /\.xt-btn\{[^}]*min-height:44px/);
  assert.match(js, /\.xt-menu button\{[^}]*padding:12px 10px/);
  for (const l of ['en', 'it', 'es', 'fr', 'ja', 'ko', 'zh']) assert.match(js, new RegExp(`\\n    ${l}: \\{ label:`), l);
});

test('the share page\'s two links are 44px rows', () => {
  assert.match(rule(read('docs', 'get', 'index.html'), '.links a'), /min-height: 44px/);
});

test('on touch the logo is a 44px target and short links are 44px wide', () => {
  const css = read('docs', 'site.css');
  const touch = css.slice(css.indexOf('@media (pointer: coarse) {\n  .xc ol'));
  assert.match(touch.slice(0, touch.indexOf('\n}')), /\.xh-brand \{ padding-block: 8px; \}/);
  assert.match(touch.slice(0, touch.indexOf('\n}')), /\.xc a, \.xg a \{ min-height: 44px; min-width: 44px; \}/);
  assert.match(rule(css, '.jump a'), /min-width: 44px/);
  assert.match(rule(css, '.xf-brand .xh-brand'), /justify-self: start/);
  assert.match(rule(read('docs', 'guide.css'), '.os-col .os-more a'), /min-width: 44px/);
});

test('the links on a generated entry page are 24px with a mouse and 44px on touch', () => {
  const src = read('tools', 'build-seo.mjs');
  assert.match(src, /\.facts a,\.ent-more \.note a\{display:inline-flex;align-items:center;min-height:24px\}/);
  assert.match(src, /@media\(pointer:coarse\)\{\.facts a,\.ent-more \.note a\{min-height:44px\}\}/);
});

test('words on a coloured card take the sheet\'s ink, and a settings mock on it stays a panel', () => {
  const guide = read('docs', 'guide.css');
  assert.match(guide, /\.card\.accent :is\(p, ul, ol, a\), \.card\.accent :is\(p, li\) strong \{ color: inherit; \}/);
  assert.match(read('docs', 'phone.html'), /\.card\.accent \.ui \{ background: var\(--g-0\); \}/);
});

test('the language button is a 44px target on touch, like its twin on the guide pages', () => {
  const css = read('docs', 'site.css');
  assert.match(css, /@media \(pointer: coarse\) \{[^\n]*\.xh \.lang-btn \{ min-height: 44px; min-width: 44px; \}/);
});

test('catalog links outside the cards are 24px with a mouse and 44px on touch', () => {
  const page = read('docs', 'catalog', 'index.html');
  assert.match(rule(page, '.seo-index a'), /display: inline-flex; align-items: center; min-height: 24px/);
  assert.match(rule(page, '.sup-mail'), /display: inline-flex; align-items: center; min-height: 24px/);
  assert.match(page, /@media \(pointer: coarse\) \{ \.seo-index ul \{ row-gap: 0; \} \.seo-index a, \.sup-mail \{ min-height: 44px; min-width: 44px; \} \}/);
  assert.match(rule(page, '.seg button'), /min-width: 44px/);
  // A creator's name sits in a line of small print: on touch the target grows
  // past the text without moving the card.
  assert.match(page, /\.cat-by a, \.drop-by a, \.dt-by a \{ display: inline-flex; align-items: center; min-height: 24px; \}/);
  assert.match(page, /@media \(pointer: coarse\) \{ \.cat-by a, \.drop-by a, \.dt-by a \{ position: relative; \} \.cat-by a::after, \.drop-by a::after, \.dt-by a::after \{ content: ""; position: absolute; inset: -10px -6px; \} \}/);
});

test('the links in the table of what you can make are 24px with a mouse and 44px on touch', () => {
  const page = read('docs', 'create', 'index.html');
  assert.match(rule(page, '#map td a'), /display: inline-flex; align-items: center; min-height: 24px/);
  assert.match(page, /@media \(pointer: coarse\) \{ #map td a \{ min-height: 44px; min-width: 44px; \} \}/);
});

test('a code block\'s name wraps on a phone instead of being cut', () => {
  const page = read('docs', 'create', 'index.html');
  const phone = page.slice(page.indexOf('@media (max-width: 600px) {\n    .tablewrap { overflow: visible; }'));
  assert.match(phone.slice(0, phone.indexOf('</style>')), /\.code-bar \.fname \{ white-space: normal; overflow-wrap: anywhere; \}/);
});
