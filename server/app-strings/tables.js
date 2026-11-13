'use strict';
// The app's words as the server reads them: one file per language,
// js/i18n/<code>.js, each a plain table of key -> text (one key holds a list,
// the weekday names). English is the full list. The table a page gets for any
// other language is English completed by that language's own words, which is
// what the old single js/i18n.js built with `...i18n.en`: a key the language
// lacks reads in English, and English never replaces a translation.
//
// The languages are an explicit list (SUPPORTED_LANGS), never the content of the
// folder: an update leaves old files on disk. A file is read and run in an empty
// sandbox each time and never `require`d, so the server keeps what it builds
// from a table and not eleven tables.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FOLDER = path.join(__dirname, '..', 'js', 'i18n');
const FALLBACK = 'en';
// Used when the shared constants are not linked in this copy (server/shared).
const BUILT_IN = Object.freeze(['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl']);

function supportedLanguages() {
  try {
    const list = require('../shared/src/constants.js').SUPPORTED_LANGS;
    if (Array.isArray(list) && list.includes(FALLBACK)) return Object.freeze([...list]);
  } catch { /* the built-in list stands in */ }
  return BUILT_IN;
}

const LANGS = supportedLanguages();
const isLanguage = (code) => LANGS.includes(code);
const fileOf = (code) => path.join(FOLDER, `${code}.js`);

const isText = (value) => typeof value === 'string';
const isTextList = (value) => Array.isArray(value) && value.every(isText);

/**
 * The table a language file holds, as plain objects of this process.
 * @param {string} source the file's text
 * @param {string} [name] for error messages
 * @returns {Record<string, string | string[]>}
 */
function parse(source, name = 'language file') {
  const box = { module: { exports: null } };
  vm.runInNewContext(source, box, { filename: name, timeout: 5000 });
  const raw = box.module.exports;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${name}: no table of strings`);
  const table = {};
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (isText(value)) table[key] = value;
    else if (isTextList(value)) table[key] = [...value];
  }
  return table;
}

/** One language's own words, as its file says them. Rejects for an unknown code. */
async function read(code) {
  if (!isLanguage(code)) throw new Error(`not a language of the app: ${String(code).slice(0, 12)}`);
  return parse(await fs.promises.readFile(fileOf(code), 'utf8'), `js/i18n/${code}.js`);
}

/** English first, the language's own words over it. */
const complete = (english, own) => ({ ...english, ...own });

/**
 * The tables a page holds for `codes`, in that order; codes the app does not
 * have are left out. A language whose file cannot be read is left out too and
 * the page reads in English; without English nothing can be said, so that throws.
 * @param {string[]} codes
 * @returns {Promise<Record<string, Record<string, string | string[]>>>}
 */
async function tables(codes) {
  const wanted = [...new Set(Array.isArray(codes) ? codes : [])].filter(isLanguage);
  const out = {};
  if (!wanted.length) return out;
  const english = await read(FALLBACK);
  for (const code of wanted) {
    if (code === FALLBACK) { out[code] = english; continue; }
    try {
      out[code] = complete(english, await read(code));
    } catch (e) {
      console.error(`[strings] ${code} is unreadable, English stands in:`, e?.message);
    }
  }
  return out;
}

/** Changes when any language file does: what a cache of built strings is valid for. */
async function stamp() {
  const times = await Promise.all(LANGS.map((code) => fs.promises.stat(fileOf(code)).then((s) => s.mtimeMs, () => 0)));
  return times.join(',');
}

module.exports = { LANGS, FALLBACK, FOLDER, isLanguage, fileOf, parse, read, complete, tables, stamp };
