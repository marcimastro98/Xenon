// The home's search box looks through docs/widget-search.json. The file is built from
// the app's own "+" panel, so it must never drift from it, and the count the home says
// out loud is that same list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_LANGS, appStrings, buildIndex } from '../../tools/build-widget-search.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const { WIDGET_CATEGORIES } = require('../js/palette-model.js');
const saved = JSON.parse(readFileSync(join(root, 'docs', 'widget-search.json'), 'utf8'));
const home = readFileSync(join(root, 'docs', 'index.html'), 'utf8');

test('the search index matches the app panel (run tools/build-widget-search.mjs)', () => {
  assert.deepEqual(saved, buildIndex(appStrings(), WIDGET_CATEGORIES));
});

test('every widget has a name in all the site languages', () => {
  assert.equal(saved.count, saved.widgets.length);
  for (const w of saved.widgets) {
    for (const lang of SITE_LANGS) assert.ok(w.name[lang], `${w.id} ${lang}`);
  }
});

test('a widget with no string in the app stays out of the index', () => {
  const strings = { en: { layout_widget_a: 'A' } };
  const index = buildIndex(strings, [{ ids: ['a', 'not-named'] }]);
  assert.deepEqual(index.widgets.map((w) => w.id), ['a']);
});

test('a language without its own string falls back to English', () => {
  const strings = { en: { layout_widget_a: 'A', palette_kw_a: 'one' }, it: {} };
  const [widget] = buildIndex(strings, [{ ids: ['a'] }]).widgets;
  assert.equal(widget.name.it, 'A');
  assert.equal(widget.words.it, 'one');
});

test('the number on the home is the number of widgets, in every language', () => {
  const tables = [...home.matchAll(/ {2}I18N\.([a-z]{2}) = \{([\s\S]*?)\n {2}\};/g)];
  assert.equal(tables.length, SITE_LANGS.length);
  for (const [, lang, body] of tables) {
    const line = body.match(/"widgets\.p": "([^"]+)"/)[1];
    assert.equal(line.match(/\d+/)[0], String(saved.count), `${lang}: ${line}`);
  }
});
