import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The matcher behind the Settings search and the "add widget" palette. It is
// run here against the REAL translations, in all 11 languages, because a
// search that works in the two languages its author types is the failure this
// feature was asked not to have.
const require = createRequire(import.meta.url);
const F = require('../js/fuzzy-find.js');

const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];

function loadI18n() {
  const src = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
  const cut = src.search(/^function /m);
  const ctx = { module: {} };
  vm.createContext(ctx);
  vm.runInContext(src.slice(0, cut) + ';globalThis.__i18n = i18n;', ctx, { filename: 'i18n.js' });
  return ctx.__i18n;
}
const i18n = loadI18n();

const entry = (id, fields) => ({ id, fields });
const ids = (results) => results.map((r) => r.entry.id);

test('fold: case, accents, full-width, ß, kana and punctuation', () => {
  assert.equal(F.fold('Luminosità'), 'luminosita');
  assert.equal(F.fold('ＡＢＣ１２'), 'abc12');
  assert.equal(F.fold('Straße'), 'strasse');
  assert.equal(F.fold('Ёлка'), 'елка');
  assert.equal(F.fold('йод'), 'йод', 'й is its own letter, not и with an accent');
  assert.equal(F.fold('テーマ'), F.fold('てーま'));
  assert.equal(F.fold('ﾃｰﾏ'), F.fold('テーマ'), 'half-width katakana');
  assert.equal(F.fold('Wi-Fi / LAN'), 'wi fi lan');
});

test('tiers: exact > word > prefix > word start > substring > typo > letters in order', () => {
  const idx = F.createIndex([
    entry('exact', [{ text: 'tema', weight: 1 }]),
    entry('word', [{ text: 'il tema scuro', weight: 1 }]),
    entry('prefix', [{ text: 'temario', weight: 1 }]),
    entry('start', [{ text: 'un temario', weight: 1 }]),
    entry('sub', [{ text: 'sistema', weight: 1 }]),
    entry('typo', [{ text: 'tena', weight: 1, fuzzy: true }]),
  ]);
  assert.deepEqual(ids(F.search(idx, 'tema')), ['exact', 'word', 'prefix', 'start', 'sub', 'typo']);
  // "tena" is one letter from "tema": found, and below every real match.
  assert.equal(ids(F.search(idx, 'tema')).includes('typo'), true);
  assert.equal(ids(F.search(idx, 'tema')).at(-1), 'typo');
});

test('typos are forgiven only in fuzzy fields, and only within the distance', () => {
  const idx = F.createIndex([
    entry('bright', [{ text: 'Brightness', weight: 1, fuzzy: true }]),
    entry('temp', [{ text: 'Temperature', weight: 1, fuzzy: true }]),
    entry('strict', [{ text: 'Brightness', weight: 1 }]),
  ]);
  assert.deepEqual(ids(F.search(idx, 'brighness')), ['bright'], 'one letter missing');
  assert.deepEqual(ids(F.search(idx, 'temperatrue')), ['temp'], 'two letters swapped');
  assert.deepEqual(ids(F.search(idx, 'brihgt')), ['bright'], 'a swap while still typing');
  assert.deepEqual(ids(F.search(idx, 'brxxxxess')), [], 'too far is not a match');
});

test('every word must match somewhere, and order counts', () => {
  const idx = F.createIndex([
    entry('a', [{ text: 'Temperature unit', weight: 1 }]),
    entry('b', [{ text: 'Unit of the temperature sensor', weight: 1 }]),
    entry('c', [{ text: 'Temperature', weight: 1 }]),
  ]);
  assert.deepEqual(ids(F.search(idx, 'temperature unit')), ['a', 'b']);
  assert.deepEqual(ids(F.search(idx, 'zzz')), []);
});

test('a single Latin letter only matches at a word start', () => {
  const idx = F.createIndex([entry('a', [{ text: 'Timer', weight: 1 }]), entry('b', [{ text: 'Notes', weight: 1 }])]);
  assert.deepEqual(ids(F.search(idx, 't')), ['a']);
});

test('Korean: a half-typed syllable and initials alone both find the word', () => {
  const idx = F.createIndex([entry('weather', [{ text: '날씨', weight: 1 }]), entry('other', [{ text: '노트', weight: 1 }])]);
  assert.equal(ids(F.search(idx, '날ㅆ'))[0], 'weather', 'IME mid-syllable');
  assert.equal(ids(F.search(idx, 'ㄴㅆ'))[0], 'weather', 'initial consonants');
  assert.equal(ids(F.search(idx, '날씨'))[0], 'weather');
});

test('Japanese and Chinese: a word inside a sentence ranks like a word', () => {
  const idx = F.createIndex([
    entry('ja', [{ text: '画面の明るさを調整', weight: 1 }]),
    entry('zh', [{ text: '调整屏幕亮度', weight: 1 }]),
  ]);
  const ja = F.search(idx, '明るさ');
  assert.equal(ja[0].entry.id, 'ja');
  assert.ok(ja[0].score >= 0.6);
  assert.equal(F.search(idx, '亮度')[0].entry.id, 'zh');
});

test('one real setting is found from each of the 11 languages', () => {
  const lang = 'it';
  const keys = ['deck_opt_brightness', 'layout_widget_weather', 'layout_widget_system', 'layout_widget_media', 'layout_widget_notes', 'layout_widget_timer'];
  const idx = F.createIndex(keys.map((k) => entry(k, F.i18nFields(i18n, k, 1, { lang, fuzzy: true }))));
  const queries = {
    it: 'luminosita', en: 'brightness', ko: '밝기', ja: '明るさ', zh: '亮度', es: 'brillo',
    fr: 'luminosite', de: 'helligkeit', pt: 'brilho', ru: 'яркость', nl: 'helderheid',
  };
  for (const l of LANGS) {
    assert.ok(i18n[l].deck_opt_brightness, `${l} has the key`);
    assert.equal(ids(F.search(idx, queries[l]))[0], 'deck_opt_brightness', `${l}: ${queries[l]}`);
  }
  // Typed in the user's own language wins over the same word elsewhere.
  const weights = F.i18nFields(i18n, 'deck_opt_brightness', 1, { lang: 'de' });
  assert.equal(weights.find((f) => f.text === i18n.de.deck_opt_brightness).weight, 1);
});

test('i18nFields: the active language full, English next, typos only in those two', () => {
  const dict = { it: { k: 'Meteo' }, en: { k: 'Weather' }, de: { k: 'Wetter' } };
  const f = F.i18nFields(dict, 'k', 1, { lang: 'it', fuzzy: true });
  assert.deepEqual(f.map((x) => [x.text, x.weight, x.fuzzy]), [['Meteo', 1, true], ['Weather', 0.9, true], ['Wetter', 0.5, false]]);
  assert.deepEqual(F.i18nFields(dict, 'k', 1, { lang: 'it', mainOnly: true }).map((x) => x.text), ['Meteo', 'Weather']);
  assert.deepEqual(F.i18nFields(dict, 'missing', 1), []);
});

test('highlight maps back onto the original text', () => {
  assert.deepEqual(F.highlight('Luminosità dello schermo', 'lumino schermo'), [[0, 6], [17, 24]]);
  assert.deepEqual(F.highlight('Luminosità', 'luminosita'), [[0, 10]]);
  assert.deepEqual(F.highlight('Straße', 'strasse'), [[0, 6]]);
  assert.deepEqual(F.highlight('날씨', '날ㅆ'), [[0, 2]]);
  assert.deepEqual(F.highlight('Brightness', 'brighness'), [], 'a typo highlights nothing');
});

test('fast enough to run on every key press over every language', () => {
  // Every English key in all 11 languages: several times the real Settings
  // index, so the bound below has room on a slow machine.
  const keys = Object.keys(i18n.en).slice(0, 1500);
  const idx = F.createIndex(keys.map((k) => entry(k, F.i18nFields(i18n, k, 1, { lang: 'it', fuzzy: true }))));
  const qs = ['lum', 'luminosita', 'brighness', 'meteo', '밝기', '明るさ', 'temperatura unita'];
  F.search(idx, 'warm up');
  const t0 = performance.now();
  for (const q of qs) F.search(idx, q);
  const per = (performance.now() - t0) / qs.length;
  assert.ok(per < 40, `a search took ${per.toFixed(1)} ms`);
});
