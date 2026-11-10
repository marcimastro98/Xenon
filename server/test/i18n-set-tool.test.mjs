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

test('a new key that is not a plain identifier is added quoted, so the file still parses', () => {
  const { source } = setI18nKeys(SAMPLE, { 'remote.pin_placeholder': { ko: 'PIN' } });
  assert.equal(load(source).ko['remote.pin_placeholder'], 'PIN');
});

test('null removes the key from every language, overrides included', () => {
  const { source, changes } = setI18nKeys(SAMPLE, { hello: null });
  assert.doesNotMatch(source, /hello/);
  assert.equal(changes.length, 4);
  assert.equal(load(source).it.other, 'Resta');
});

test('a key on a line with other keys is rewritten where it stands, never added beside it', () => {
  const long = [
    'const i18n = {',
    '  it: {',
    "    first: 'Uno', second: 'Vecchio', third: 'Tre',",
    '  },',
    '};',
  ].join('\n');
  const { source, changes } = setI18nKeys(long, { second: { it: 'Nuovo' } });
  assert.equal(changes[0].kind, 'set');
  assert.match(source, /first: 'Uno', second: 'Nuovo', third: 'Tre',/);
  assert.equal((source.match(/second:/g) || []).length, 1);

  const removed = setI18nKeys(long, { second: null }).source;
  assert.match(removed, /first: 'Uno', third: 'Tre',/);
  assert.doesNotMatch(removed, /second/);
});

// A one-line patch is a whole Object.assign on one line, and the last
// definition of a key wins at runtime even when it sits there.
const PATCHED = [
  SAMPLE,
  'Object.assign(i18n.it, { other: \'Riga vecchia\' });',
  'Object.assign(i18n.en, { only: "Patch only", hello: \'Hi patch\', after: "Stays" });',
].join('\n');

test('languageRegions sees a one-line patch as its own region', () => {
  const regions = languageRegions(PATCHED.split('\n'));
  assert.deepEqual(regions.slice(-2).map((r) => `${r.lang}:${r.start}-${r.end}:${r.inline}`), ['it:23-24:true', 'en:24-25:true']);
  assert.equal(regions.filter((r) => r.inline).length, 2);
});

test('a key in a one-line patch is rewritten there, so the runtime value changes', () => {
  const { source, changes } = setI18nKeys(PATCHED, {
    other: { it: 'Riga nuova' },
    only: { en: 'Patched "only"' },
    hello: { en: 'Hello' },
  });
  assert.ok(changes.every((c) => c.kind === 'set'), 'never added into the main block');
  assert.deepEqual(changes.map((c) => `${c.key}@${c.line}`), ['other@4', 'other@24', 'only@25', 'hello@7', 'hello@25']);
  const i18n = load(source);
  assert.equal(i18n.it.other, 'Riga nuova');
  assert.equal(i18n.en.only, 'Patched "only"');
  assert.equal(i18n.en.hello, 'Hello');
  assert.equal(i18n.en.after, 'Stays');
  assert.match(source, /^Object\.assign\(i18n\.en, \{ only: "Patched \\"only\\"", hello: 'Hello', after: "Stays" \}\);$/m);
});

test('null empties a one-line patch and drops the line that is left', () => {
  const { source } = setI18nKeys(PATCHED, { other: null, only: null });
  assert.doesNotMatch(source, /Object\.assign\(i18n\.it, \{\s*\}\);/);
  assert.match(source, /^Object\.assign\(i18n\.en, \{ hello: 'Hi patch', after: "Stays" \}\);$/m);
  assert.equal(load(source).it.other, undefined);
});

test('a language with only one-line patches cannot take a new key', () => {
  const inlineOnly = 'const i18n = { xy: {} };\nObject.assign(i18n.xy, { a: \'A\' });';
  assert.equal(load(setI18nKeys(inlineOnly, { a: { xy: 'B' } }).source).xy.a, 'B');
  assert.throws(() => setI18nKeys(inlineOnly, { b: { xy: 'B' } }), /b\.xy: no block to add the key to/);
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

test('on the real i18n.js every key of a one-line patch takes a new value at runtime', (t) => {
  const src = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
  const updates = {};
  let pairs = 0;
  for (const line of src.split(/\r?\n/)) {
    const m = /^Object\.assign\(i18n\.([a-z]{2}), (\{.*\})\);\s*$/.exec(line);
    if (!m) continue;
    for (const key of Object.keys(vm.runInNewContext(`(${m[2]})`))) {
      (updates[key] ||= {})[m[1]] = `PROBE ${key} ${m[1]}`;
      pairs++;
    }
  }
  if (!pairs) return t.skip('no one-line patch left in i18n.js');
  const { source, changes } = setI18nKeys(src, updates);
  assert.ok(changes.every((c) => c.kind === 'set'), 'a key already there is never added again');
  const i18n = vm.runInNewContext(`${source}\ni18n;`);
  const stale = Object.entries(updates).flatMap(([key, perLang]) =>
    Object.entries(perLang).filter(([lang, value]) => i18n[lang][key] !== value).map(([lang]) => `${key}.${lang}`));
  assert.deepEqual(stale, []);
});
