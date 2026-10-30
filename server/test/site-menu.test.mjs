// One menu on every site page: the shared header (tools/site-chrome.mjs) and
// the home's own copy of it list the same places in the same order, in all 7
// site languages, and every page on disk carries the current one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headerHtml, footerHtml, chromeLabels } from '../../tools/site-chrome.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const docs = join(root, 'docs');
const read = (p) => readFileSync(join(root, p), 'utf8');
const SITE_LANGS = ['en', 'it', 'es', 'fr', 'ja', 'ko', 'zh'];

// Demo, Catalog, Maker (Beta), Supporters, Help: the order of the brand plan.
const MENU = ['/demo/', '/catalog/', '/maker/', '/#support', '/faq.html'];

// Hrefs of the first <ul> inside `<nav ...class>`; a language copy's
// /it/... prefix and the home's bare #anchor read as the English path.
function menuOf(html, navOpen) {
  const at = html.indexOf(navOpen);
  assert.ok(at >= 0, `no ${navOpen}`);
  const list = html.slice(at, html.indexOf('</ul>', at));
  return [...list.matchAll(/<li><a href="([^"]+)"/g)].map((m) => m[1]
    .replace(/^\/(it|es|fr|ja|ko|zh)\//, '/')
    .replace(/^#/, '/#'));
}

test('the shared header lists Demo, Catalog, Maker (Beta), Supporters, Help, then Download', () => {
  const h = headerHtml();
  assert.deepEqual(menuOf(h, '<nav class="xh-nav"'), MENU);
  assert.deepEqual(menuOf(h, '<ul class="xh-mlist"'), MENU, 'the phone menu is the same list');
  assert.match(h, /<a href="\/maker\/"><span data-xl="maker">Maker<\/span><span class="xh-beta" data-xl="beta">Beta<\/span><\/a>/);
  assert.match(h, /<a href="\/#support"><span data-xl="supporters">Supporters<\/span><\/a>|<a href="\/#support" data-xl="supporters">Supporters<\/a>/);
  assert.match(h, /class="xh-dl"[^>]*data-xl="download">Download</);
});

test('the home carries the same menu as every other page', () => {
  const home = read('docs/index.html');
  assert.deepEqual(menuOf(home, '<nav aria-label="Main"'), MENU);
  assert.deepEqual(menuOf(home, '<ul class="mlist"'), MENU);
  assert.match(home, /<a href="\/maker\/"><span data-i18n="nav.maker">Maker<\/span><span class="beta" data-i18n="beta">Beta<\/span><\/a>/);
});

test('every page on disk carries the current menu', () => {
  const pages = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory() && e.name !== 'demo') walk(p);
      else if (e.name.endsWith('.html')) pages.push(p);
    }
  };
  walk(docs);
  let seen = 0;
  for (const p of pages) {
    const html = readFileSync(p, 'utf8');
    const name = relative(root, p);
    if (html.includes('<!-- xenon:header -->')) {
      seen++;
      assert.deepEqual(menuOf(html, '<nav class="xh-nav"'), MENU, name);
      assert.deepEqual(menuOf(html, '<ul class="xh-mlist"'), MENU, `${name} (phone menu)`);
    } else if (html.includes('<header class="hd"')) {
      seen++;
      assert.deepEqual(menuOf(html, '<nav aria-label="Main"'), MENU, name);
    }
  }
  assert.ok(seen > 40, `only ${seen} pages with a menu`);
});

test('the menu labels exist in all 7 site languages', () => {
  const L = chromeLabels();
  const home = read('docs/index.html');
  for (const lang of SITE_LANGS) {
    for (const k of ['demo', 'catalog', 'maker', 'beta', 'supporters', 'help', 'download', 'f.maker']) {
      assert.ok(L[lang]?.[k], `chrome.js ${lang}.${k}`);
    }
    const block = home.slice(home.indexOf(`I18N.${lang} = {`));
    const body = block.slice(0, block.indexOf('\n  };'));
    for (const k of ['nav.maker', 'nav.supporters', 'beta', 'ft.maker']) {
      assert.match(body, new RegExp(`\\n    "${k.replace('.', '\\.')}": "[^"]+"`), `home ${lang} ${k}`);
    }
  }
});

// guide.css gives every li an 8px bottom margin; in the bar and the footer it
// made the guides' menu rows and footer links looser than the home's.
test('the header and footer lists keep their spacing on the guide pages', () => {
  assert.match(read('docs/guide.css'), /(^|\n)li \{ margin-bottom: 8px; \}/, 'the rule this guards against');
  assert.match(read('docs/site.css'), /\n\.xh li, \.xf li \{ margin: 0; \}/);
});

// The Beta tag is 22px tall, the labels' line 16.5px: left inline, it pushed
// "Maker" 2.6px below the other names (seen in the browser, 27 Oct 2026).
test('the Maker label sits on the same line as the others, tag included', () => {
  const site = read('docs/site.css');
  assert.match(site, /\n\.xh \.xh-nav ul \{[^}]*display: flex; align-items: center;/);
  assert.match(site, /\n\.xh \.xh-nav a:has\(\.xh-beta\) \{ display: inline-flex; align-items: center; \}/);
  const home = read('docs/index.html');
  assert.match(home, /\n\.hd \.w > nav ul \{[^}]*display: flex; align-items: center;/);
  assert.match(home, /\n\.hd \.w > nav a:has\(\.beta\) \{ display: inline-flex; align-items: center; \}/);
});

test('the footer links the Maker from the App column, on the home too', () => {
  assert.match(footerHtml(), /<li><a href="\/maker\/" data-xl="f\.maker">Xenon Maker<\/a><\/li>/);
  assert.match(read('docs/index.html'), /<li><a href="\/maker\/" data-i18n="ft\.maker">Xenon Maker<\/a><\/li>/);
});
