// The catalog translated itself only in the browser, so search engines saw it
// in English alone and Search Console reported /zh/catalog/ and the other
// localized addresses as 404s. tools/catalog-langs.mjs now writes a copy per
// language at /<lang>/catalog/ with the words baked in; these tests keep the
// committed copies, the English page and the runtime in step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogCopy, readCatalogTable } from '../../tools/catalog-langs.mjs';
import { CATALOG_PAGE, langsOf } from '../../tools/lang-pages.mjs';
import { chromeLabels, localizeUrls } from '../../tools/lang-copy.mjs';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs');
const read = (rel) => fs.readFileSync(path.join(DOCS, rel), 'utf8').replace(/\r\n/g, '\n');
const english = read('catalog/index.html');
const table = readCatalogTable(english);

test('every catalog language carries every English string, title and description', () => {
  const keys = Object.keys(table.en);
  for (const lang of langsOf(CATALOG_PAGE.page)) {
    assert.ok(table[lang], 'no table for ' + lang);
    assert.deepEqual(keys.filter((k) => table[lang][k] == null), [], lang + ' is missing strings');
    assert.ok([...table[lang]['meta.title']].length <= 60, lang + ' title is longer than a results page shows');
    assert.ok([...table[lang]['meta.desc']].length <= 160, lang + ' description is longer than a results page shows');
  }
});

test('each committed copy is exactly what the builder makes from the English page', () => {
  const labels = chromeLabels(DOCS);
  for (const lang of CATALOG_PAGE.langs) {
    const want = catalogCopy(english, lang, table, labels);
    assert.equal(read(lang + '/catalog/index.html'), want, `docs/${lang}/catalog/index.html is stale: run node tools/catalog-langs.mjs`);
  }
});

test('a copy is crawled in its own language at its own address', () => {
  const fr = read('fr/catalog/index.html');
  assert.match(fr, /<html lang="fr" data-langs="en,es,fr,it,ja,ko,zh"/);
  assert.match(fr, /<link rel="canonical" href="https:\/\/xenon-app\.com\/fr\/catalog\/">/);
  assert.match(fr, /<title>Catalogue Xenon/);
  assert.match(fr, /<h1 id="pg-h" data-i18n-html="hero\.h">Catalogue<\/h1>/);
  assert.match(fr, /window\.__XENON_SITE_LANG = "fr";/);
  assert.match(fr, /<h2 data-n="\d+">Les \d+ créations de la communauté<\/h2>/);
  assert.match(fr, /"inLanguage": "fr"/);
});

test('the English page and every copy list all seven addresses', () => {
  for (const file of ['catalog/index.html', ...CATALOG_PAGE.langs.map((l) => l + '/catalog/index.html')]) {
    const html = read(file);
    for (const lang of CATALOG_PAGE.langs) {
      assert.ok(html.includes(`<link rel="alternate" hreflang="${lang}" href="https://xenon-app.com/${lang}/catalog/">`), `${file} lacks hreflang ${lang}`);
    }
    assert.ok(html.includes('<link rel="alternate" hreflang="x-default" href="https://xenon-app.com/catalog/">'), file + ' lacks x-default');
  }
});

test('the catalog loads its files from the site root, so a copy one folder down finds them', () => {
  assert.doesNotMatch(english, /(?:href|src)="\.\.?\//);
  assert.doesNotMatch(english, /fetch\('(?!\/|https:)/);
  assert.doesNotMatch(english, /'\.\.\/community\//);
});

test('a copy starts in its language, and the menu opens the other copy on the same entry', () => {
  assert.match(english, /let init = LANGS\.includes\(window\.__XENON_SITE_LANG\) \? window\.__XENON_SITE_LANG : null;/);
  assert.match(english, /location\.href = \(lang === 'en' \? '\/catalog\/' : '\/' \+ lang \+ '\/catalog\/'\) \+ location\.search \+ location\.hash;/);
});

test('links in other language copies point at the catalog in that language, entry pages stay shared', () => {
  const s = localizeUrls('<a href="/catalog/">a</a><a href="/catalog/#casa">b</a><a href="/catalog/casa/">c</a>', 'es');
  assert.equal(s, '<a href="/es/catalog/">a</a><a href="/es/catalog/#casa">b</a><a href="/catalog/casa/">c</a>');
});
