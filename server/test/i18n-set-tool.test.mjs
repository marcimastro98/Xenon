// tools/i18n-set.mjs sets app strings across the language files
// (server/js/i18n/<code>.js). These run it on small files in that shape, and
// once on the real ones without writing anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LANGS, languageFile, ownTables, renderTables, setI18nKeys } from '../../tools/i18n-set.mjs';

const file = (lines) => ["'use strict';", 'module.exports = {', ...lines, '};', ''].join('\n');
const sample = () => ({
  it: file(["  hello: 'Ciao — vecchio',", "  other: 'Resta',"]),
  en: file(["  hello: 'Hi',", "  other: 'Stays',", "  weekdays: ['Mon', 'Tue'],"]),
  ko: file(["  other: '그대로',"]),
});

const real = () => Object.fromEntries(LANGS.map((code) => [code, readFileSync(new URL(`../../${languageFile(code)}`, import.meta.url), 'utf8')]));

test('sets the key in the language it is given for, and nowhere else', () => {
  const { texts, changes } = setI18nKeys(sample(), { hello: { it: 'Ciao, nuovo' } });
  const own = ownTables(texts);
  assert.equal(own.it.hello, 'Ciao, nuovo');
  assert.equal(own.en.hello, 'Hi');
  assert.ok(!Object.hasOwn(own.ko, 'hello'), 'a language that had no translation still has none');
  assert.deepEqual(changes, [{ key: 'hello', lang: 'it', kind: 'set' }]);
  assert.doesNotMatch(texts.it, /vecchio/);
});

test('a key the language lacks is added in English\'s order', () => {
  const { texts, changes } = setI18nKeys(sample(), { hello: { ko: '안녕' } });
  assert.deepEqual(changes, [{ key: 'hello', lang: 'ko', kind: 'add' }]);
  assert.deepEqual(Object.keys(ownTables(texts).ko), ['hello', 'other']);
  assert.match(texts.ko, /^ {2}hello: '안녕',\n {2}other: '그대로',$/m);
});

test('a brand new key goes to the end of English and of the others', () => {
  const { texts } = setI18nKeys(sample(), { fresh: { en: 'New', it: 'Nuovo' } });
  const own = ownTables(texts);
  assert.deepEqual(Object.keys(own.en), ['hello', 'other', 'weekdays', 'fresh']);
  assert.deepEqual(Object.keys(own.it), ['hello', 'other', 'fresh']);
});

test('quotes, backslashes and new lines survive, and the files still run', () => {
  const tricky = 'It\'s "so" \\ long\nsecond line';
  const { texts } = setI18nKeys(sample(), { hello: { en: tricky }, 'remote.pin_placeholder': { ko: 'PIN' }, 'deck_opt_next-monitor': { ko: '다음' } });
  const own = ownTables(texts);
  assert.equal(own.en.hello, tricky);
  assert.equal(own.ko['remote.pin_placeholder'], 'PIN');
  assert.equal(own.ko['deck_opt_next-monitor'], '다음');
  assert.match(texts.en, /hello: 'It\\'s "so" \\\\ long\\nsecond line',/);
});

test('null removes the key from every language that has it', () => {
  const { texts, changes } = setI18nKeys(sample(), { other: null });
  assert.doesNotMatch(Object.values(texts).join('\n'), /^ +other:/m);
  assert.deepEqual(changes.map((c) => `${c.lang}:${c.kind}`), ['it:remove', 'en:remove', 'ko:remove']);
  assert.equal(ownTables(texts).it.hello, 'Ciao — vecchio');
  assert.deepEqual(ownTables(texts).en.weekdays, ['Mon', 'Tue'], 'the one list of the app is kept as a list');
});

test('a value that is already there changes nothing', () => {
  const before = renderTables(ownTables(sample()));
  const { texts, changes } = setI18nKeys(before, { hello: { en: 'Hi' } });
  assert.deepEqual(changes, []);
  assert.deepEqual(texts, before);
});

test('a hand edit out of shape is read and written back in shape', () => {
  const messy = { ...sample(), it: 'module.exports = { other: "Resta",\n  hello: "Ciao" };\n' };
  const { texts } = setI18nKeys(messy, { hello: { it: 'Salve' } });
  assert.match(texts.it, /^module\.exports = \{\n {2}hello: 'Salve',\n {2}other: 'Resta',\n\};\n$/m);
});

test('rejects an unknown language, a non-string value and a key that is not one', () => {
  assert.throws(() => setI18nKeys(sample(), { hello: { xx: 'x' } }), /no file for language "xx"/);
  assert.throws(() => setI18nKeys(sample(), { hello: { it: 3 } }), /must be a string/);
  assert.throws(() => setI18nKeys(sample(), JSON.parse('{ "__proto__": { "it": "x" } }')), /not a key/);
  assert.throws(() => setI18nKeys(sample(), { '': { it: 'x' } }), /not a key/);
});

test('the real files: all 11 languages, already in the tool\'s shape', () => {
  assert.deepEqual([...LANGS], ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl']);
  const before = real();
  assert.deepEqual(renderTables(ownTables(before)), before, 'node tools/restructure/i18n-split.mjs --write puts them back');
});

test('on the real files a new value reaches exactly the language it was given for', () => {
  const before = real();
  const { texts, changes } = setI18nKeys(before, { online: { ja: 'PROBE ja' }, a_key_nobody_has: { en: 'PROBE en' } });
  assert.deepEqual(changes.map((c) => `${c.key}.${c.lang}:${c.kind}`), ['online.ja:set', 'a_key_nobody_has.en:add']);
  assert.deepEqual(LANGS.filter((code) => texts[code] !== before[code]), ['en', 'ja']);
  const own = ownTables(texts);
  assert.equal(own.ja.online, 'PROBE ja');
  assert.equal(own.en.a_key_nobody_has, 'PROBE en');
  assert.equal(Object.keys(own.en).pop(), 'a_key_nobody_has');
});
