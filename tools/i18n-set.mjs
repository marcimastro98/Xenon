#!/usr/bin/env node
// Sets app strings in server/js/i18n/<code>.js, one value per language.
//
// Rewriting copy by hand across 11 languages kept missing one of them, so this
// takes one list of values and puts each in its language's file. A file holds a
// key once, one per line, and is written back in the shape every other tool
// expects (tools/restructure/i18n-render.mjs: English's key order, single
// quotes), so a hand edit that left it is tidied on the way.
//
// A key a language has no translation for is left out of its file and reads in
// English: give a language only words that are its own.
//
// Run:  node tools/i18n-set.mjs <updates.json> [--check]
//   updates.json = { "key": { "it": "...", "en": "...", ... }, "gone": null }
//   A null removes that key from every language.
//   --check prints what would change and writes nothing.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGLISH, renderLanguage } from './restructure/i18n-render.mjs';

const Tables = createRequire(import.meta.url)('../server/app-strings/tables.js');

export const LANGS = Tables.LANGS;
/** @param {string} code @returns {string} repo-relative path of a language's file */
export const languageFile = (code) => `server/js/i18n/${code}.js`;

/**
 * Each language's own words, from the text of its file.
 * @param {Record<string, string>} texts language code -> its file's text
 * @returns {Record<string, Record<string, string | string[]>>}
 */
export function ownTables(texts) {
  return Object.fromEntries(Object.entries(texts).map(([code, text]) => [code, Tables.parse(text, languageFile(code))]));
}

/**
 * The files for these tables, in the one shape. English gives the key order.
 * @param {Record<string, Record<string, string | string[]>>} own
 * @returns {Record<string, string>} language code -> its file's text
 */
export function renderTables(own) {
  const englishKeys = Object.keys(own[ENGLISH] || {});
  return Object.fromEntries(Object.keys(own).map((code) => [code, renderLanguage(code, own[code], englishKeys)]));
}

/**
 * Pure: every update applied.
 * @param {Record<string, string>} texts language code -> its file's text
 * @param {Record<string, Record<string, string> | null>} updates
 * @returns {{ texts: Record<string, string>, changes: { key: string, lang: string, kind: 'set' | 'add' | 'remove' }[] }}
 */
export function setI18nKeys(texts, updates) {
  const own = ownTables(texts);
  const changes = [];
  for (const [key, perLang] of Object.entries(updates)) {
    if (!key || key === '__proto__') throw new Error(`not a key: "${key}"`);
    if (perLang === null) {
      for (const lang of Object.keys(own)) {
        if (!Object.hasOwn(own[lang], key)) continue;
        delete own[lang][key];
        changes.push({ key, lang, kind: 'remove' });
      }
      continue;
    }
    for (const [lang, value] of Object.entries(perLang)) {
      if (typeof value !== 'string') throw new Error(`${key}.${lang}: value must be a string`);
      if (!Object.hasOwn(own, lang)) throw new Error(`no file for language "${lang}"`);
      const had = Object.hasOwn(own[lang], key);
      if (had && own[lang][key] === value) continue;
      own[lang][key] = value;
      changes.push({ key, lang, kind: had ? 'set' : 'add' });
    }
  }
  return { texts: renderTables(own), changes };
}

function main(argv) {
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node tools/i18n-set.mjs <updates.json> [--check]');
    process.exit(2);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const at = (code) => path.join(root, languageFile(code));
  const before = Object.fromEntries(LANGS.map((code) => [code, fs.readFileSync(at(code), 'utf8')]));
  const updates = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { texts, changes } = setI18nKeys(before, updates);
  for (const c of changes) console.log(`${c.kind} ${c.key} [${c.lang}]`);
  const changed = LANGS.filter((code) => texts[code] !== before[code]);
  if (argv.includes('--check')) {
    console.log(`${changes.length} change(s) in ${changed.length} file(s), nothing written`);
    return;
  }
  for (const code of changed) fs.writeFileSync(at(code), texts[code], 'utf8');
  console.log(`${changes.length} change(s) written to ${changed.map(languageFile).join(', ') || 'no file'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
