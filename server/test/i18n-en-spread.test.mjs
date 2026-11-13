import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

// Regression guard for a silent, invisible bug. When the words were one file,
// several language blocks carried `...i18n.en` in the MIDDLE of the object, so
// every translation written ABOVE the spread was overwritten by English at load
// time: 241 strings across nine languages rendered in English while the correct
// translation sat in the file. Nothing surfaces this. The app runs, the key
// resolves, the text is simply the wrong language.
//
// Each language now has its own file with its own words only, and English is
// added in ONE place (complete() in server/app-strings/tables.js). So the rule
// is pinned there: English supplies the fallback, a translation always wins, and
// no language file can pull English in by itself.
const require = createRequire(import.meta.url);
const Tables = require('../app-strings/tables.js');
const LayerStrings = require('../layer-strings.js');
const OTHERS = Tables.LANGS.filter((code) => code !== Tables.FALLBACK);
const fileText = (code) => readFileSync(Tables.fileOf(code), 'utf8');

test('the app declares at least the shipped languages, each with its file', () => {
  for (const expected of ['it', 'en', 'ko', 'ja', 'zh']) {
    assert.ok(Tables.LANGS.includes(expected), `missing language: ${expected}`);
  }
  for (const code of Tables.LANGS) assert.ok(Object.keys(Tables.parse(fileText(code))).length > 1000, `${code}: its file has no words`);
});

test('English fills what a language lacks and never replaces a translation', () => {
  const page = Tables.complete({ a: 'English a', b: 'English b' }, { b: 'tradotto' });
  assert.deepEqual(page, { a: 'English a', b: 'tradotto' });
  assert.deepEqual(Object.keys(page), ['a', 'b'], 'in English\'s order');
});

test('no language file brings English in by itself: no spread, no require', () => {
  for (const code of Tables.LANGS) {
    const text = fileText(code);
    assert.doesNotMatch(text, /^\s*\.\.\./m, `${code}: a spread in a language file`);
    assert.doesNotMatch(text, /\brequire\s*\(/, `${code}: a language file loads another file`);
  }
});

test('on a page every translation in a language file is the text shown', async () => {
  const english = await Tables.read(Tables.FALLBACK);
  const page = await Tables.tables([...Tables.LANGS]);
  assert.deepEqual(Object.keys(page), [...Tables.LANGS]);
  for (const code of OTHERS) {
    const own = await Tables.read(code);
    const lost = Object.keys(own).filter((key) => JSON.stringify(page[code][key]) !== JSON.stringify(own[key]));
    assert.deepEqual(lost, [], `${code}: English replaced these translations`);
    const holes = Object.keys(english).filter((key) => !Object.hasOwn(page[code], key));
    assert.deepEqual(holes, [], `${code}: these keys are missing on the page`);
  }
});

test('the script a page loads says the translation, and English only for a gap', async () => {
  const script = await LayerStrings.scriptFor(['en', 'it'], 'it');
  const ctx = vm.createContext({ lang: 'it' });
  vm.runInContext(script, ctx);
  const [it, en] = await Promise.all([Tables.read('it'), Tables.read('en')]);
  const translated = Object.keys(it).find((key) => typeof it[key] === 'string' && it[key] !== en[key]);
  assert.equal(vm.runInContext(`t(${JSON.stringify(translated)})`, ctx), it[translated]);
  const gap = Object.keys(en).find((key) => !Object.hasOwn(it, key));
  if (gap) assert.equal(vm.runInContext(`t(${JSON.stringify(gap)})`, ctx), en[gap]);
});
