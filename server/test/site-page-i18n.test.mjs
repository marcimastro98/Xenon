// The site's pages other than the home keep their English in docs/<page>.html
// and the translations in tools/i18n/<name>.json, next to a snapshot of the
// English each one was made from. When the page's English changes and nobody
// translates the change, the copies keep shipping the old text: the FAQ's
// games answer did in Nov 2026. build-page-langs.mjs only logs that during the
// deploy, so this test is what stops it reaching the site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPage } from '../../tools/page-i18n.mjs';
import { LANG_PAGES, langsOf, readDictFiles } from '../../tools/lang-pages.mjs';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs');

// Same pages and languages the builder checks: a page with an inline table has
// no snapshot, and a language with no dictionary yet is not published.
for (const entry of LANG_PAGES.filter((e) => e.dict !== 'inline')) {
  test(`${entry.page}: every translation is made from the page's current English`, () => {
    const html = fs.readFileSync(path.join(DOCS, entry.page), 'utf8').replace(/\r\n/g, '\n');
    const langs = langsOf(entry.page).filter((l) => l !== 'en');
    assert.deepEqual(checkPage(html, readDictFiles(entry.dict), langs), []);
  });
}

test('a snapshot behind the page is reported as stale', () => {
  const html = '<div data-i18n-html="f.a.x"><p>New English.</p></div>';
  const table = (text) => ({ 'f.a.x': text, 'meta.title': 'T', 'meta.desc': 'D' });
  const dict = { en: table('<p>Old English.</p>'), it: table('<p>Vecchio.</p>') };
  assert.deepEqual(checkPage(html, dict, ['it']), ['stale (English changed): f.a.x']);
});
