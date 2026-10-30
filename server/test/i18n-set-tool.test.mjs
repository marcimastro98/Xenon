// tools/i18n-set.mjs rewrites app strings across every language block of
// server/js/i18n.js. These run it on a small copy of that file's shapes: a
// main block, a main block behind the English spread, the Dutch quoted-key
// style, and a later Object.assign override that must change too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { setI18nKeys, languageRegions } from '../../tools/i18n-set.mjs';

const SAMPLE = [
  'const i18n = {',
  '  it: {',
  "    hello: 'Ciao — vecchio',",
  "    other: 'Resta',",
  '  },',
  '  en: {',
  "    hello: 'Hi',",
  '  },',
  '};',
  'Object.assign(i18n, {',
  '  ko: {',
  '    ...i18n.en,',
  "    other: '그대로',",
  '  },',
  '  nl: {',
  '    ...i18n.en,',
  '    "hello": "Hallo",',
  '  },',
  '});',
  'Object.assign(i18n.it, {',
  "  hello: 'Ciao override',",
  '});',
  'function t(key) {}',
].join('\n');

const load = (source) => vm.runInNewContext(`${source}\ni18n;`);

test('languageRegions finds main blocks and Object.assign overrides', () => {
  const regions = languageRegions(SAMPLE.split('\n'));
  assert.deepEqual(regions.map((r) => `${r.lang}:${r.main}`), ['it:true', 'en:true', 'ko:true', 'nl:true', 'it:false']);
});

test('sets every definition of a key for the language, override included', () => {
  const { source, changes } = setI18nKeys(SAMPLE, { hello: { it: 'Ciao, nuovo' } });
  assert.equal((source.match(/Ciao, nuovo/g) || []).length, 2);
  assert.doesNotMatch(source, /vecchio|override/);
  assert.equal(changes.length, 2);
  assert.match(source, /hello: 'Hi'/, 'other languages untouched');
});

test('keeps the Dutch quoted style and escapes quotes', () => {
  const { source } = setI18nKeys(SAMPLE, { hello: { nl: 'Zeg "hoi"', en: "It's" } });
  assert.match(source, /"hello": "Zeg \\"hoi\\"",/);
  assert.match(source, /hello: 'It\\'s',/);
  // The result is still valid JavaScript.
  assert.doesNotThrow(() => load(source));
});

test('a missing key lands after the English spread, never before it', () => {
  const { source, changes } = setI18nKeys(SAMPLE, { hello: { ko: '안녕' } });
  const lines = source.split('\n');
  const spread = lines.indexOf('    ...i18n.en,', lines.indexOf('  ko: {'));
  assert.equal(lines[spread + 1], "    hello: '안녕',");
  assert.equal(changes[0].kind, 'add');
  const i18n = load(source);
  assert.equal(i18n.ko.hello, '안녕');
});

test('null removes the key from every language, overrides included', () => {
  const { source, changes } = setI18nKeys(SAMPLE, { hello: null });
  assert.doesNotMatch(source, /hello/);
  assert.equal(changes.length, 4);
  assert.equal(load(source).it.other, 'Resta');
});

test('rejects an unknown language and a non-string value', () => {
  assert.throws(() => setI18nKeys(SAMPLE, { hello: { xx: 'x' } }), /no block for language "xx"/);
  assert.throws(() => setI18nKeys(SAMPLE, { hello: { it: 3 } }), /must be a string/);
});

test('the real i18n.js has a main block for all 11 languages', () => {
  const src = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
  const mains = languageRegions(src.split(/\r?\n/)).filter((r) => r.main).map((r) => r.lang);
  assert.deepEqual(mains, ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl']);
});
