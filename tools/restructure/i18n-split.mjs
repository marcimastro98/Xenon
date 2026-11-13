#!/usr/bin/env node
// The app's words, one file per language.
//
// On the old single server/js/i18n.js it runs the file in a sandbox, takes each
// language's own words (what a browser held, minus what only came from the
// `...i18n.en` spread) and writes server/js/i18n/<code>.js, leaving js/i18n.js
// with the functions alone. On files already split it puts them back in their
// one shape (one key per line, English's order), which changes nothing when they
// already are.
//
//   node tools/restructure/i18n-split.mjs            what would change (exit 1 when something would)
//   node tools/restructure/i18n-split.mjs --write    write it
//   node tools/restructure/i18n-split.mjs --report   what is wrong in the words themselves

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLegacy, readLegacy } from './i18n-legacy.mjs';
import { defects } from './i18n-proof.mjs';
import { ENGLISH, renderCore, renderLanguage } from './i18n-render.mjs';

const require = createRequire(import.meta.url);
const Tables = require('../../server/app-strings/tables.js');

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CORE_FILE = 'server/js/i18n.js';
export const languageFile = (code) => `server/js/i18n/${code}.js`;

function languageFiles(own, langs) {
  const englishKeys = Object.keys(own[ENGLISH]);
  return new Map(langs.map((code) => [languageFile(code), renderLanguage(code, own[code], englishKeys)]));
}

/**
 * The files the old single i18n.js becomes.
 * @param {string} source
 * @param {readonly string[]} [langs] the app's languages, in order
 * @returns {{ files: Map<string, string>, legacy: ReturnType<typeof readLegacy> }}
 */
export function splitLegacy(source, langs = Tables.LANGS) {
  const legacy = readLegacy(source);
  if (legacy.langs.join() !== [...langs].join()) {
    throw new Error(`i18n.js holds ${legacy.langs.join()} but the app's languages are ${[...langs].join()}`);
  }
  const files = languageFiles(legacy.own, legacy.langs);
  files.set(CORE_FILE, renderCore(legacy.runtime));
  return { files, legacy };
}

/**
 * Language files put back in their one shape.
 * @param {Record<string, string>} texts language code -> its file's text
 * @param {readonly string[]} [langs]
 * @returns {{ files: Map<string, string>, own: Record<string, Record<string, string | string[]>> }}
 */
export function tidy(texts, langs = Tables.LANGS) {
  const own = {};
  for (const code of langs) {
    if (typeof texts[code] !== 'string') throw new Error(`${languageFile(code)} is missing`);
    own[code] = Tables.parse(texts[code], languageFile(code));
  }
  return { files: languageFiles(own, [...langs]), own };
}

const readIfThere = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

/**
 * What the tool would write under `root`, and which of it differs from the disk.
 * @param {string} [root]
 */
export function plan(root = ROOT) {
  const core = fs.readFileSync(path.join(root, CORE_FILE), 'utf8');
  const split = isLegacy(core);
  let result;
  if (split) result = splitLegacy(core);
  else result = tidy(Object.fromEntries(Tables.LANGS.map((code) => [code, readIfThere(path.join(root, languageFile(code)))])));
  const own = split ? result.legacy.own : result.own;
  const changed = [...result.files.keys()].filter((rel) => readIfThere(path.join(root, rel)) !== result.files.get(rel));
  return { mode: split ? 'split' : 'tidy', files: result.files, changed, own, legacy: split ? result.legacy : null };
}

function printReport(own) {
  const found = defects(own);
  console.log(`Keys a language has and English does not: ${found.notInEnglish.length}`);
  for (const row of found.notInEnglish) console.log(`  ${row.lang}.${row.key}`);
  console.log(`Placeholders that differ from English: ${found.placeholders.length}`);
  for (const row of found.placeholders.slice(0, 40)) console.log(`  ${row.lang}.${row.key}: {${row.own}} for {${row.english}}`);
  console.log(`Keys only English has: ${found.englishOnly.length}${found.englishOnly.length ? ` (${found.englishOnly.slice(0, 10).join(', ')})` : ''}`);
  console.log(`Read in English for now: ${Object.entries(found.untranslated).map(([lang, n]) => `${lang} ${n}`).join(', ')}`);
}

function main(args) {
  const { mode, files, changed, own, legacy } = plan();
  if (args.includes('--report')) { printReport(own); return 0; }
  if (legacy) {
    const dropped = Object.values(legacy.inherited).reduce((sum, keys) => sum + keys.length, 0);
    console.log(`Old single file: ${legacy.langs.length} languages, ${legacy.spreads} English spreads, ${dropped} strings that were only English copies stay in English alone.`);
  }
  for (const code of Object.keys(own)) console.log(`  ${code}: ${Object.keys(own[code]).length} keys`);
  if (!changed.length) { console.log(`Nothing to ${mode}: every file is already in its shape.`); return 0; }
  for (const rel of changed) console.log(`  ${args.includes('--write') ? 'written' : 'would change'}: ${rel}`);
  if (!args.includes('--write')) { console.log('Run again with --write.'); return 1; }
  for (const rel of changed) {
    const file = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, files.get(rel));
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
