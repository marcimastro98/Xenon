// Every hand-written page opens on a sheet: a flat colour with the page's name
// and Bit, one bar colour, the shared chrome. The share, status and submit pages
// keep their working parts on it, and the submit form reads in all seven languages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { LANG_PAGES } from '../../tools/lang-pages.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...path) => readFileSync(join(root, 'docs', ...path), 'utf8').replace(/\r\n/g, '\n');
const SHEETS = ['download.html', 'thanks.html', '404.html', 'catalog/index.html', 'get/index.html', 'submit/index.html', 'submit/status/index.html', 'create/index.html',
  'catalog/nitrato/index.html', 'catalog/deep-ocean/index.html', 'creators/swiv/index.html']
  .concat(LANG_PAGES.map((p) => p.page));
const site = read('site.css');

test('every page opens on one sheet, with one name and something beside it', () => {
  for (const file of new Set(SHEETS)) {
    const html = read(file);
    assert.match(html, /<body[^>]* data-sheet="[a-z]+"/, `${file}: no sheet`);
    assert.equal((html.match(/<section class="pg"/g) || []).length, 1, `${file}: one sheet`);
    assert.match(html, /<h1 id="pg-h"/, `${file}: the sheet names the page`);
    // Beside the name stands the product or Bit; a wide sheet gives all its width to what it holds.
    if (!/class="pg-w wide"/.test(html)) assert.match(html, /class="pg-(bit|pic)/, `${file}: nothing stands beside the name`);
    assert.equal((html.match(/<meta name="theme-color"/g) || []).length, 1, `${file}: one bar colour`);
  }
});

test('the focus ring follows the sheet it sits on', () => {
  assert.match(site, /:focus-visible \{\n {2}outline: 2px solid var\(--focus, var\(--bone-0\)\);/);
  assert.match(site, /\.pg \{ --focus: var\(--sheet-ink\);/);
});

test('the column under the sheet is shared, so a page does not need guide.css for it', () => {
  assert.match(site, /\.pg-body \{ max-width: 1440px;/);
  assert.match(site, /\.pg-body:has\(> \.jump\) \{ display: grid;/);
  assert.doesNotMatch(read('guide.css'), /\.pg-body|\.jump/);
});

test('a Japanese title breaks between words', () => {
  assert.match(site, /:lang\(ja\) \.pg :is\(h1, \.pg-title\) \{ word-break: auto-phrase; \}/);
});

test('the share page works before its script runs, and shows the code when there is one', () => {
  const html = read('get', 'index.html');
  assert.match(html, /<div id="no-code">/, 'the download path is visible by default');
  assert.match(html, /<div id="has-code" hidden>/);
  assert.match(html, /<ol class="steps" id="steps" hidden>/);
  assert.match(html, /<button id="copy" class="pg-key"/);
  assert.match(html, /noBox\.hidden = true;/);
  assert.match(html, /getElementById\('steps'\)\.hidden = false;/);
  assert.doesNotMatch(html, /\bn?tag: /, 'no kicker over the name');
  assert.doesNotMatch(html, /dans <b>Paste it/, 'the French step is French');
});

test('a step keeps its text in one column', () => {
  const html = read('get', 'index.html');
  assert.doesNotMatch(html, /\.steps li \{[^}]*display: grid/, 'text and bold would become grid cells');
});

test('the colour of the status page says where a submission stands', () => {
  const js = read('submit', 'status', 'status.js');
  const tone = /var TONE = \{([^}]*)\}/.exec(js)[1];
  for (const pair of ["s_pending: 'violet'", "s_fix: 'orange'", "s_free: 'green'", "s_sellable: 'green'", "s_approved: 'green'", "s_rejected: 'red'"]) {
    assert.ok(tone.includes(pair), pair);
  }
  assert.match(js, /TONE\[key\] \|\| 'orange'/, 'a bad link or no answer is not a state of the submission');
  assert.match(js, /document\.body\.setAttribute\('data-sheet'/);
  assert.match(js, /sheet\.bar\.content = /, 'the browser bar follows the sheet');
  const html = read('submit', 'status', 'index.html');
  assert.match(html, /<div class="pg-act" id="st-act">/);
  assert.match(html, /#st-state:empty, #st-meta:empty, #st-act:empty \{ display: none; \}/);
  assert.match(html, /\.pg h1 \{ overflow-wrap: anywhere; \}/, 'a creator can pick a long name');
});

test('a status with nothing under the sheet leaves no empty band above the footer', () => {
  const html = read('submit', 'status', 'index.html');
  assert.match(html, /<div class="wrap" id="st-root"><\/div>/, ':empty needs the box to hold nothing, not even a space');
  assert.match(html, /\.pg-body:has\(#st-root:empty\) \{ display: none; \}/);
  assert.match(html, /body:has\(#st-root:empty\) \.xf \{ margin-top: 0; \}/);
});

test('severity uses the sheets on both pages: no side bars, no outline in text colours', () => {
  for (const file of [['submit', 'index.html'], ['submit', 'status', 'index.html']]) {
    const html = read(...file);
    assert.doesNotMatch(html, /border-left/, file.join('/'));
    assert.match(html, /\[data-sheet\] \{ box-shadow: inset 0 0 0 2px var\(--sheet\); \}/, file.join('/'));
    assert.match(html, /background: var\(--sheet\); color: var\(--sheet-ink\);/, file.join('/'));
  }
  assert.match(read('submit', 'status', 'status.js'), /SEVERITY_SHEET = \{ block: 'red', fix: 'orange' \}/);
  assert.match(read('submit', 'index.html'), /SEVERITY_SHEET = \{ block: 'red', warn: 'orange' \}/);
});

const submit = read('submit', 'index.html');

test('the list beside the form points at every section of it', () => {
  const links = [...submit.match(/<nav class="jump"[\s\S]*?<\/nav>/)[0].matchAll(/href="#([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(links, ['s-about', 's-code', 's-check', 's-colours', 's-shots', 's-send']);
  for (const id of links) assert.match(submit, new RegExp(`<div class="card" id="${id}">\\n {6}<h2`), id);
  assert.match(submit, /aria-labelledby="code-h"/, 'the code box keeps a name without its old label');
});

test('the form keeps its fields lined up and every slot reachable by keyboard', () => {
  assert.match(submit, /\.grid2 label\.f \{ display: flex; flex-direction: column; justify-content: space-between; \}/);
  assert.match(submit, /document\.createElement\(shots\[i\] \? 'div' : 'button'\)/);
  assert.match(submit, /frame\.type = 'button';/);
  assert.doesNotMatch(submit, /outline: none/, 'the shared focus ring stays');
});

test('success takes over the sheet, moves focus to it and drops the list', () => {
  assert.match(submit, /<div id="okHead" hidden>\n\s+<p id="ok-h" class="pg-title" role="heading" aria-level="1" tabindex="-1"/);
  const done = submit.slice(submit.indexOf("if (out && out.ok) {"), submit.indexOf("var err = (out && out.error)"));
  assert.match(done, /getElementById\('jump'\)\.remove\(\)/);
  assert.match(done, /getElementById\('okHead'\)\.hidden = false/);
  assert.match(done, /getElementById\('ok-h'\)\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(submit, /🎉/);
});

test('every string of the form exists in all seven languages', () => {
  const at = submit.indexOf('var DICTS');
  const code = submit.slice(at, submit.indexOf('var LANGS', at));
  const { DICTS } = vm.runInNewContext(code + '; ({ DICTS })');
  const used = new Set([...submit.matchAll(/data-t(?:-ph)?="([^"]+)"/g)].map((m) => m[1]));
  for (const m of submit.matchAll(/\bT\('([^']+)'/g)) used.add(m[1]);
  assert.ok(used.size > 90);
  for (const lang of ['fr', 'it', 'es', 'ko', 'ja', 'zh']) {
    const missing = [...used].filter((key) => !DICTS[lang][key]);
    assert.deepEqual(missing, [], lang);
    for (const [key, text] of Object.entries(DICTS[lang])) {
      assert.doesNotMatch(text, /—|→$/, `${lang}.${key}`);
    }
    for (const key of ['e_version_lower', 'target_found', 'e_generic']) {
      for (const slot of (DICTS.it[key] || '').match(/\{[a-z]+\}/g) || []) {
        assert.ok(DICTS[lang][key].includes(slot), `${lang}.${key} keeps ${slot}`);
      }
    }
  }
});

test('the promo strip pushes what sits under it, not only the header', () => {
  assert.ok(read('promo.js').includes("setProperty('--strip-h', (px || 0) + 'px')"));
  const under = (file, text) => assert.ok(file.includes(text.replace('STRIP', 'var(--strip-h, 0px)')), text);
  under(read('guide.css'), 'html { scroll-padding-top: calc(88px + STRIP); }');
  under(site, '.pg-body > .jump { position: sticky; top: calc(96px + STRIP);');
  under(read('index.html'), 'html { scroll-padding-top: calc(84px + STRIP);');
  under(read('submit', 'index.html'), 'scroll-padding-top: calc(88px + STRIP);');
  const create = read('create', 'index.html');
  under(create, 'scroll-padding-top: calc(var(--top-off, 88px) + STRIP);');
  under(create, 'position: sticky; top: calc(84px + STRIP);');
  under(create, '.guide-bar { top: STRIP; }');
});
