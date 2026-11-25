// The site's Bit page (docs/bit.html + docs/bit-page.js): a person's own Bit by its number, only
// what the hub shows (GET /bit/<n>, /bit/stats), drawn with the Bit kit; every name as text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { LANG_PAGES } from '../../tools/lang-pages.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const PAGE = read('docs', 'bit.html');
const JS = read('docs', 'bit-page.js');
const LANGS = ['en', 'es', 'fr', 'it', 'ja', 'ko', 'zh'];

test('the page loads the engine before its own script, and is in every list of pages', () => {
  const kit = PAGE.indexOf('<script src="/create/bit-kit.js" defer>');
  assert.ok(kit > 0 && kit < PAGE.indexOf('<script src="/bit-page.js" defer>'));
  assert.ok(LANG_PAGES.some((p) => p.page === 'bit.html' && p.dict === 'bit'));
  assert.match(read('tools', 'build-seo.mjs'), /loc: '\/bit\.html'/);
  assert.match(read('docs', 'sitemap.xml'), /<loc>https:\/\/xenon-app\.com\/bit\.html<\/loc>/);
  for (const l of LANGS.slice(1)) assert.match(read('docs', l, 'bit.html'), new RegExp(`<html lang="${l}"`), l);
});

test('only the hub\'s public answers, without cookies, and a number from the hash', () => {
  assert.match(JS, /const HUB = 'https:\/\/xenon-supporter-hub\.xenonedge\.workers\.dev';/);
  assert.match(JS, /fetch\(HUB \+ path, \{ credentials: 'omit', signal: ctl\.signal \}\)/);
  assert.match(JS, /const HASH = \/\^#\(\[1-9\]\\d\{0,8\}\)\$\/;/);
  assert.match(JS, /getJson\('\/bit\/' \+ n\)/);
  assert.match(JS, /getJson\('\/bit\/stats'\)/);
});

test('names go in as text and the small Bits as pictures, never as markup', () => {
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
    assert.ok(!JS.includes(bad), bad);
  }
  assert.match(JS, /'data:image\/svg\+xml;charset=utf-8,' \+ encodeURIComponent\(svg\)/);
  assert.match(JS, /img\.alt = '';/);
  assert.match(JS, /textContent: bit\.name \|\| number/);
  assert.match(JS, /if \(!bit \|\| bit\.number !== n\)/, 'an answer for another Bit is not drawn');
});

test('every word the script writes, in the seven languages of the site', () => {
  const m = /const WORDS = (\{[\s\S]*?\n {2}\});/.exec(JS);
  assert.ok(m, 'WORDS table');
  const words = vm.runInNewContext(`(${m[1]})`);
  assert.deepEqual(Object.keys(words).sort(), [...LANGS].sort());
  const keys = Object.keys(words.en).sort();
  for (const l of LANGS) {
    assert.deepEqual(Object.keys(words[l]).sort(), keys, l);
    for (const k of ['number', 'looking', 'missing']) assert.match(words[l][k], /\{n\}/, `${l} ${k}`);
    assert.match(words[l].count, /\{born\}[\s\S]*\{shown\}/, `${l} count`);
  }
});

test('the page says what it shows and how a Bit gets on it, in every language', () => {
  const dict = JSON.parse(read('tools', 'i18n', 'bit.json'));
  const keys = Object.keys(dict.en).sort();
  for (const l of LANGS) assert.deepEqual(Object.keys(dict[l]).sort(), keys, l);
  // The switch is named as the app names it (mybit_site), so a person finds it.
  const app = { en: 'en', es: 'es', fr: 'fr', it: 'it', ja: 'ja', ko: 'ko', zh: 'zh' };
  for (const [l, code] of Object.entries(app)) {
    const label = /\n {2}mybit_site: '([^']+)'/.exec(read('server', 'js', 'i18n', `${code}.js`))[1];
    assert.ok(dict[l]['bit.how.p1'].includes(`<strong>${label}</strong>`), `${l}: ${label}`);
  }
});
