// The app's words were one file of 73,412 lines (server/js/i18n.js, eleven
// languages, later blocks patching earlier ones) until tools/restructure/
// i18n-split.mjs wrote them out one file per language. This is the proof that
// the split changed nothing anyone can read: every answer of t(), every table.
//
// "Before" is that old file taken from git by the id of its content, so nothing
// is stored twice and a rewritten history still finds it. "After" is the split
// as it first entered the repo (the working tree until then): strings changed
// later are not this test's business. Without git, or in a clone too shallow to
// hold the old file, it skips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allKeys, answers, compareAnswers, compareTables } from '../../tools/restructure/i18n-proof.mjs';
import { CORE_FILE, languageFile, splitLegacy } from '../../tools/restructure/i18n-split.mjs';

const require = createRequire(import.meta.url);
const Tables = require('../app-strings/tables.js');
const LayerStrings = require('../layer-strings.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OLD_FILE = '3d148db1f88a819c8572bdef4c5ae2c6f4593d8e'; // git's id of the last single js/i18n.js
const LANGS = [...Tables.LANGS];
const SPLIT_FILES = [...LANGS.map(languageFile), CORE_FILE];

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

// The split files as first committed, or as they are on disk before that.
function splitTexts() {
  const added = (git('log', '--diff-filter=A', '--format=%H', '--', languageFile('en')) || '').trim().split('\n').filter(Boolean).pop();
  const read = (rel) => (added ? git('show', `${added}:${rel}`) : fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  const texts = Object.fromEntries(SPLIT_FILES.map((rel) => [rel, read(rel)]));
  return Object.values(texts).every((text) => typeof text === 'string') ? { texts, from: added || 'the working tree' } : null;
}

const oldSource = git('cat-file', 'blob', OLD_FILE);
const after = oldSource ? splitTexts() : null;
const skip = after ? false : 'the old single i18n.js is not in this copy (no git, or a shallow clone)';

// Computed once: the old file read as a browser read it, and the split read as the server reads it.
const world = (() => {
  if (skip) return null;
  const { files, legacy } = splitLegacy(oldSource, LANGS);
  const own = Object.fromEntries(LANGS.map((code) => [code, Tables.parse(after.texts[languageFile(code)], languageFile(code))]));
  const page = Object.fromEntries(LANGS.map((code) => [code, code === Tables.FALLBACK ? own[code] : Tables.complete(own[Tables.FALLBACK], own[code])]));
  return { files, legacy, own, page, core: after.texts[CORE_FILE], keys: [...allKeys(legacy.resolved, own), 'no_such_key_anywhere'] };
})();

test('the split in the repo is byte for byte what the tool writes from the old file', { skip }, (t) => {
  t.diagnostic(`old file ${OLD_FILE.slice(0, 12)}, split read from ${after.from}`);
  assert.deepEqual([...world.files.keys()], SPLIT_FILES);
  for (const rel of SPLIT_FILES) assert.ok(after.texts[rel] === world.files.get(rel), `${rel} is not what the tool writes`);
  assert.ok(oldSource.endsWith(world.core.slice(world.core.indexOf('\nfunction t(key) {'))), 'the functions of js/i18n.js are the old ones, untouched');
});

test('every language keeps its own words: same keys, same text, and no English copied in', { skip }, (t) => {
  assert.deepEqual(world.legacy.langs, LANGS, 'eleven languages, in the same order');
  const diff = compareTables(world.legacy.own, world.own);
  t.diagnostic(`${LANGS.length} languages, ${diff.pairs} strings compared`);
  assert.deepEqual({ changed: diff.changed, gone: diff.gone, added: diff.added }, { changed: [], gone: [], added: [] });
  assert.deepEqual(Object.keys(world.own.en), Object.keys(world.legacy.own.en), 'English keeps its order');
});

test('t() answers the same for every key in every language', { skip }, (t) => {
  const before = answers(oldSource, LANGS, world.keys);
  const served = compareAnswers(before, answers(LayerStrings.build(world.page, world.core, ''), LANGS, world.keys), LANGS, world.keys);
  // The same with the bare files, where a missing key is truly missing: the fallback alone decides.
  const bare = compareAnswers(before, answers(LayerStrings.build(world.own, world.core, ''), LANGS, world.keys), LANGS, world.keys);
  t.diagnostic(`${LANGS.length} languages x ${world.keys.length} keys = ${served.compared} answers, ${served.mismatches.length} differ`);
  assert.deepEqual(served.mismatches.slice(0, 20), []);
  assert.deepEqual(bare.mismatches.slice(0, 20), []);
});

test('a page holds every string it held before, with the same text', { skip }, (t) => {
  const english = world.own.en;
  const diff = compareTables(world.legacy.resolved, world.page);
  t.diagnostic(`${diff.pairs} strings on pages compared, ${diff.changed.length + diff.gone.length} differ, ${diff.added.length} gaps now filled with English`);
  assert.deepEqual({ changed: diff.changed, gone: diff.gone }, { changed: [], gone: [] });
  // What a table gained is a key only English had: t() already answered it in English.
  for (const pair of diff.added) {
    const [lang, ...rest] = pair.split('.');
    const key = rest.join('.');
    assert.ok(Object.hasOwn(english, key) && world.page[lang][key] === english[key], `${pair} appeared and is not English`);
  }
});
