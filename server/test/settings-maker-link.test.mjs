import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

// The Create card in Settings is where someone who cannot code looks for a way
// to make something: it has to point at Xenon Maker, in their own language.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..');
const HTML = readFileSync(join(SERVER, 'index.html'), 'utf8');
const SRC = readFileSync(join(SERVER, 'js', 'i18n.js'), 'utf8');

function languages() {
  const cut = SRC.search(/^function /m);
  assert.ok(cut > 0, 'the data/behaviour split in i18n.js moved');
  const ctx = { module: {} };
  vm.createContext(ctx);
  vm.runInContext(SRC.slice(0, cut) + ';globalThis.__i18n = i18n;', ctx, { filename: 'i18n.js' });
  return ctx.__i18n;
}

test('the Create card links to Xenon Maker in a new tab', () => {
  const link = HTML.match(/<a [^>]*data-i18n="settings_maker_link"[^>]*>/);
  assert.ok(link, 'no Maker link in the Create card');
  assert.match(link[0], /href="https:\/\/xenon-app\.com\/maker\/"/);
  assert.match(link[0], /target="_blank"/);
  assert.match(link[0], /rel="noopener noreferrer"/);
});

test('every language names Xenon Maker in its own words', () => {
  const all = languages();
  const langs = Object.keys(all);
  assert.equal(langs.length, 11);
  const en = all.en.settings_maker_link;
  for (const lang of langs) {
    const text = all[lang].settings_maker_link;
    assert.equal(typeof text, 'string', `${lang} has no settings_maker_link`);
    assert.match(text, /Xenon Maker/, `${lang} lost the product name`);
    if (lang !== 'en') assert.notEqual(text, en, `${lang} shows the English text`);
  }
});
