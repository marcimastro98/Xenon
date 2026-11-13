// tools/restructure/i18n-split.mjs and its helpers: reading the old single
// i18n.js, writing one file per language in one fixed shape, and reading those
// files back as the server does (server/app-strings/tables.js). On small made-up
// tables; the proof on the real words is restructure-i18n-equal.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { isLegacy, readLegacy } from '../../tools/restructure/i18n-legacy.mjs';
import { answers, compareAnswers, compareTables, defects } from '../../tools/restructure/i18n-proof.mjs';
import { entryLines, keyText, literal, orderLike, quote, renderCore, renderLanguage } from '../../tools/restructure/i18n-render.mjs';
import { CORE_FILE, languageFile, plan, splitLegacy, tidy } from '../../tools/restructure/i18n-split.mjs';

const require = createRequire(import.meta.url);
const Tables = require('../app-strings/tables.js');
const LayerStrings = require('../layer-strings.js');

const cp = (...codes) => String.fromCodePoint(...codes);
const RUNTIME = '\nfunction t(key) {\n  return (i18n[lang] && i18n[lang][key]) ?? (i18n.en && i18n.en[key]) ?? key;\n}\n';
// The old file's shapes: two full blocks, a language spreading English, a later
// block and a one-line patch that override, and a key only English has.
const LEGACY = [
  "'use strict';",
  'const i18n = {',
  '  it: {',
  "    hello: 'Ciao',",
  "    quote: 'L\\'ora',",
  "    weekdays: ['Lun', 'Mar'],",
  '  },',
  '  en: {',
  "    hello: 'Hi',",
  "    quote: 'The \"hour\"',",
  "    weekdays: ['Mon', 'Tue'],",
  "    only_english: 'Only here',",
  '  },',
  '};',
  'Object.assign(i18n, {',
  '  ko: {',
  '    ...i18n.en,',
  "    hello: '안녕',",
  '  },',
  '});',
  'Object.assign(i18n.it, {',
  "  hello: 'Ciao di nuovo',",
  '});',
  "Object.assign(i18n.ko, { extra_ko: '한국어만' });",
].join('\n') + RUNTIME;
const LANGS = ['it', 'en', 'ko'];

test('a string is written so that it reads back the same, hidden characters as codes', () => {
  const hidden = [0x00, 0x1f, 0x7f, 0xa0, 0xad, 0x200b, 0x200f, 0x2028, 0x2029, 0x202f, 0x2060, 0xfeff].map((c) => cp(c));
  const samples = ['', 'plain', "it's", 'a "b"', 'back\\slash', 'line\nbreak\ttab\rreturn', '안녕 — ✓ 🎮', '${not} a `template`', ...hidden.map((h) => `a${h}b`)];
  for (const text of samples) {
    const written = quote(text);
    assert.equal(vm.runInNewContext(written), text, written);
    assert.ok(!hidden.some((h) => written.includes(h)), `a hidden character is written as itself in ${JSON.stringify(text)}`);
    assert.doesNotMatch(written, /\n/);
  }
  assert.equal(quote('a' + cp(0xa0) + 'b'), "'a" + '\\' + "u00a0b'");
  assert.equal(literal(['Mon', "Tu'e"]), "['Mon', 'Tu\\'e']");
  assert.throws(() => literal(3), /not text/);
  assert.throws(() => literal(['a', 3]), /not text/);
  assert.equal(keyText('plain_key'), 'plain_key');
  assert.equal(keyText('remote.pin'), "'remote.pin'");
  assert.equal(keyText('deck_opt_next-monitor'), "'deck_opt_next-monitor'");
});

test('keys follow English\'s order, and what English lacks goes last', () => {
  assert.deepEqual(orderLike({ z: 1, extra: 1, a: 1 }, ['a', 'b', 'z']), ['a', 'z', 'extra']);
  assert.deepEqual(orderLike({}, ['a']), []);
});

test('a language file is one key per line and reads back as the same table', () => {
  const table = { b: 'due', 'remote.pin': "l'ora", weekdays: ['Lun', 'Mar'], extra: 'in più' };
  const text = renderLanguage('it', table, ['weekdays', 'remote.pin', 'b']);
  assert.ok(text.endsWith('};\n'));
  assert.doesNotMatch(text, /\r/);
  assert.deepEqual(entryLines(text), ["  weekdays: ['Lun', 'Mar'],", "  'remote.pin': 'l\\'ora',", "  b: 'due',", "  extra: 'in più',"]);
  const back = Tables.parse(text, 'it.js');
  assert.deepEqual(back, table);
  assert.deepEqual(Object.keys(back), ['weekdays', 'remote.pin', 'b', 'extra']);
  assert.equal(renderLanguage('it', back, ['weekdays', 'remote.pin', 'b']), text, 'writing it again changes nothing');
  assert.match(renderLanguage('en', {}, []), /module\.exports = \{\n\};\n$/);
  assert.throws(() => entryLines('const x = 1;\n'), /not a language file/);
});

test('the server reads only text and lists of text from a language file', () => {
  const table = Tables.parse("module.exports = { a: 'x', n: 3, f() {}, list: ['a', 'b'], mixed: ['a', 1], o: { p: 'q' } };");
  assert.deepEqual(table, { a: 'x', list: ['a', 'b'] });
  assert.equal(Object.getPrototypeOf(table), Object.prototype, 'objects of this process, not of the sandbox');
  assert.throws(() => Tables.parse('module.exports = 3;', 'bad.js'), /bad\.js: no table of strings/);
  assert.throws(() => Tables.parse("require('node:fs');", 'bad.js'), /require is not defined/);
  assert.throws(() => Tables.parse('process.exit(1);', 'bad.js'), /process is not defined/);
});

test('the old file is read as a browser read it, own words apart from English copies', () => {
  assert.equal(isLegacy(LEGACY), true);
  const legacy = readLegacy(LEGACY);
  assert.deepEqual(legacy.langs, LANGS);
  assert.equal(legacy.spreads, 1);
  assert.equal(legacy.resolved.it.hello, 'Ciao di nuovo', 'the last definition wins');
  assert.equal(legacy.resolved.ko.only_english, 'Only here', 'the browser held the English copy');
  assert.deepEqual(legacy.own.ko, { hello: '안녕', extra_ko: '한국어만' }, 'the file will hold its own words only');
  assert.deepEqual([...legacy.inherited.ko].sort(), ['only_english', 'quote', 'weekdays']);
  assert.deepEqual(legacy.own.it, legacy.resolved.it);
  assert.equal(legacy.runtime, RUNTIME);
});

test('the old file is refused when a spread would hide or copy words', () => {
  const late = LEGACY.replace("    ...i18n.en,\n    hello: '안녕',", "    hello: '안녕',\n    ...i18n.en,");
  assert.throws(() => readLegacy(late), /ko/);
  assert.throws(() => readLegacy(LEGACY.replace('    ...i18n.en,', '    ...i18n.it,')), /spread this tool does not know/);
  assert.throws(() => readLegacy("const i18n = { en: { a: 'x' } };\n"), /function t\(key\)/);
  assert.throws(() => readLegacy(`const i18n = { en: { a: 3 } };${RUNTIME}`), /en\.a: number is neither text/);
});

test('splitting gives one file per language and the functions untouched', () => {
  const { files, legacy } = splitLegacy(LEGACY, LANGS);
  assert.deepEqual([...files.keys()], [...LANGS.map(languageFile), CORE_FILE]);
  assert.deepEqual(entryLines(files.get(languageFile('ko'))), ["  hello: '안녕',", "  extra_ko: '한국어만',"]);
  assert.deepEqual(entryLines(files.get(languageFile('it'))), ["  hello: 'Ciao di nuovo',", "  quote: 'L\\'ora',", "  weekdays: ['Lun', 'Mar'],"]);
  const core = files.get(CORE_FILE);
  assert.ok(core.endsWith(RUNTIME));
  assert.match(core, /^const i18n = \{\};$/m);
  assert.equal(isLegacy(core), false, 'the new js/i18n.js is not mistaken for the old one');
  assert.equal(core, renderCore(legacy.runtime));
  assert.throws(() => splitLegacy(LEGACY, ['it', 'en']), /holds it,en,ko but the app's languages are it,en/);
});

test('split, then read as the server does: every answer of t() is the old one', () => {
  const { files, legacy } = splitLegacy(LEGACY, LANGS);
  const own = Object.fromEntries(LANGS.map((code) => [code, Tables.parse(files.get(languageFile(code)))]));
  assert.deepEqual(compareTables(legacy.own, own), { pairs: 9, changed: [], gone: [], added: [] });
  const page = Object.fromEntries(LANGS.map((code) => [code, code === 'en' ? own.en : Tables.complete(own.en, own[code])]));
  const keys = ['hello', 'quote', 'weekdays', 'only_english', 'extra_ko', 'no_such_key'];
  const before = answers(LEGACY, LANGS, keys);
  assert.equal(before.ko[0], '안녕');
  assert.equal(before.ko[3], 'Only here');
  assert.equal(before.it[5], 'no_such_key');
  for (const tables of [page, own]) {
    const result = compareAnswers(before, answers(LayerStrings.build(tables, files.get(CORE_FILE), ''), LANGS, keys), LANGS, keys);
    assert.deepEqual(result, { compared: 18, mismatches: [] });
  }
  const wrong = { ...page, ko: { ...page.ko, hello: 'Hi' } };
  const caught = compareAnswers(before, answers(LayerStrings.build(wrong, files.get(CORE_FILE), ''), LANGS, keys), LANGS, keys);
  assert.deepEqual(caught.mismatches, [{ lang: 'ko', key: 'hello', before: '안녕', after: 'Hi' }], 'a changed string is caught');
});

test('running the tool on its own output changes nothing, and tidies a hand edit', () => {
  const { files } = splitLegacy(LEGACY, LANGS);
  const texts = Object.fromEntries(LANGS.map((code) => [code, files.get(languageFile(code))]));
  const again = tidy(texts, LANGS);
  for (const code of LANGS) assert.equal(again.files.get(languageFile(code)), texts[code], code);
  const hand = { ...texts, ko: 'module.exports = { extra_ko: "한국어만", hello: "안녕" };\n' };
  assert.equal(tidy(hand, LANGS).files.get(languageFile('ko')), texts.ko, 'back in English\'s order, single quotes');
  assert.throws(() => tidy({ it: texts.it, en: texts.en }, LANGS), /server\/js\/i18n\/ko\.js is missing/);
});

test('the tool on a folder: split once, then nothing left to do', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-split-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'server', 'js'), { recursive: true });
  // The old shape with the app's own languages: two full blocks, the rest spread English.
  const later = Tables.LANGS.filter((code) => code !== 'it' && code !== 'en');
  const source = "const i18n = {\n  it: {\n    a: 'it a',\n    b: 'it b',\n  },\n  en: {\n    a: 'A',\n    b: 'B',\n  },\n};\n"
    + `Object.assign(i18n, {\n${later.map((code) => `  ${code}: {\n    ...i18n.en,\n    a: '${code} a',\n  },`).join('\n')}\n});${RUNTIME}`;
  fs.writeFileSync(path.join(root, CORE_FILE), source);

  const first = plan(root);
  assert.equal(first.mode, 'split');
  assert.deepEqual(first.changed, [...Tables.LANGS.map(languageFile), CORE_FILE]);
  for (const rel of first.changed) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), first.files.get(rel));
  }
  assert.deepEqual(first.own.ko, { a: 'ko a' }, 'b stays in English alone');

  const second = plan(root);
  assert.equal(second.mode, 'tidy');
  assert.deepEqual(second.changed, []);
  assert.deepEqual(second.own, first.own);
});

test('the real files are in the tool\'s shape: a run would change nothing', () => {
  const now = plan();
  assert.equal(now.mode, 'tidy');
  assert.deepEqual(now.changed, [], 'run node tools/restructure/i18n-split.mjs --write');
  assert.deepEqual(Object.keys(now.own), [...Tables.LANGS]);
});

test('the server reads the same tables the tool wrote, English completing the others', async () => {
  const now = plan();
  const page = await Tables.tables([...Tables.LANGS]);
  assert.deepEqual(Object.keys(page), [...Tables.LANGS]);
  assert.deepEqual(page.en, now.own.en);
  for (const code of Tables.LANGS) assert.deepEqual(page[code], Tables.complete(now.own.en, now.own[code]), code);
  assert.deepEqual(await Tables.tables(['xx', '../en', 'it', 'it']).then(Object.keys), ['it'], 'a code that is not a language is left out');
  assert.deepEqual(await Tables.tables([]), {});
  await assert.rejects(Tables.read('../../server'), /not a language of the app/);
});

test('the languages are the shared list, and the built-in copy of it has not drifted', () => {
  const { SUPPORTED_LANGS } = require('../shared/src/constants.js');
  assert.deepEqual([...Tables.LANGS], [...SUPPORTED_LANGS]);
  const source = fs.readFileSync(new URL('../app-strings/tables.js', import.meta.url), 'utf8');
  const builtIn = /const BUILT_IN = Object\.freeze\(\[([^\]]+)\]\)/.exec(source);
  assert.ok(builtIn, 'BUILT_IN is gone from app-strings/tables.js');
  assert.deepEqual(builtIn[1].split(',').map((s) => s.trim().replace(/'/g, '')), [...SUPPORTED_LANGS]);
  assert.equal(Tables.isLanguage('en'), true);
  assert.equal(Tables.isLanguage('__proto__'), false);
});

test('what is wrong in the words is counted the same way whatever the storage', () => {
  const found = defects({
    en: { a: 'Hello {name}', b: 'Plain', only: 'English only', list: ['x'] },
    it: { a: 'Ciao {nome}', b: 'Semplice', stray: 'Non in inglese', list: ['y'] },
    ko: { a: '{name} 안녕' },
  });
  assert.deepEqual(found.notInEnglish, [{ lang: 'it', key: 'stray' }]);
  assert.deepEqual(found.placeholders, [{ lang: 'it', key: 'a', english: 'name', own: 'nome' }]);
  assert.deepEqual(found.untranslated, { it: 1, ko: 3 });
  assert.deepEqual(found.englishOnly, ['only']);
});
