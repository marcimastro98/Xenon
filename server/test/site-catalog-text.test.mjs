// The paid packs' descriptions in the reader's language: docs/catalog/text.json, the tool
// that keeps it (tools/catalog-text.mjs), and how the catalog page picks a text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { TEXT_LANGS, mergeText, reviewText } from '../../tools/catalog-text.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { entries: saved } = JSON.parse(readFileSync(join(root, 'docs', 'catalog', 'text.json'), 'utf8'));
const page = readFileSync(join(root, 'docs', 'catalog', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const DESCRIPTION_MAX = 800;

// The page's own function, run on a stand-in for its state.
function pagePicker(lang, text) {
  const source = page.slice(page.indexOf('let packText'), page.indexOf('// The name of a card is the control'));
  const context = { cur: lang };
  vm.runInNewContext(`${source}\nthis.set = (t) => { packText = t; };\nthis.descOf = descOf;`, context);
  context.set(text);
  return context.descOf;
}

test('every translation holds the English it came from and all six languages', () => {
  assert.ok(Object.keys(saved).length >= 11);
  for (const [id, own] of Object.entries(saved)) {
    assert.ok(own.en, `${id}: no English`);
    for (const lang of TEXT_LANGS) assert.ok(own[lang], `${id}: no ${lang}`);
  }
});

test('each text fits what a card keeps, with no long dash', () => {
  for (const [id, own] of Object.entries(saved)) {
    for (const lang of TEXT_LANGS) {
      assert.ok(own[lang].length <= DESCRIPTION_MAX, `${id} ${lang}`);
      assert.doesNotMatch(own[lang], /[–—]/, `${id} ${lang}`);
    }
  }
});

test('the page shows the translation while the hub text is the one it was made from', () => {
  const text = { nitrato: { en: 'A town.', it: 'Un paese.' } };
  assert.equal(pagePicker('it', text)({ id: 'nitrato', description: 'A town.' }), 'Un paese.');
});

test('a text changed on the hub, a language or an entry with no translation: the hub text', () => {
  const text = { nitrato: { en: 'A town.', it: 'Un paese.' } };
  assert.equal(pagePicker('it', text)({ id: 'nitrato', description: 'A new town.' }), 'A new town.');
  assert.equal(pagePicker('fr', text)({ id: 'nitrato', description: 'A town.' }), 'A town.');
  assert.equal(pagePicker('it', text)({ id: 'other', description: 'Else.' }), 'Else.');
  assert.equal(pagePicker('it', {})({ id: 'nitrato', description: 'A town.' }), 'A town.');
});

test('the tool lists what is missing and what the hub changed, paid packs only', () => {
  const entries = [
    { id: 'kept', locked: true, description: 'Same. ' },
    { id: 'moved', locked: true, description: 'New.' },
    { id: 'none', locked: true, description: 'Fresh.' },
    { id: 'free', description: 'Free.' },
  ];
  const text = { kept: { en: 'Same.' }, moved: { en: 'Old.' } };
  assert.deepEqual(reviewText(entries, text), { missing: ['none'], stale: ['moved'] });
});

test('adding stamps today\'s English and refuses a gap or an unknown entry', () => {
  const words = Object.fromEntries(TEXT_LANGS.map((lang) => [lang, ` ${lang} `]));
  const merged = mergeText([{ id: 'a', description: ' English. ' }], {}, { a: words });
  assert.equal(merged.a.en, 'English.');
  assert.equal(merged.a.it, 'it');
  assert.throws(() => mergeText([{ id: 'a', description: 'E' }], {}, { b: words }), /no entry "b"/);
  assert.throws(() => mergeText([{ id: 'a', description: 'E' }], {}, { a: { it: 'x' } }), /lacks es/);
});
