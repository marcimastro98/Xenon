'use strict';

// The app's strings as every page loads them, served as `/layer-i18n.js`: the
// saved language and the browser's, plus English for t()'s fallback, not all
// eleven. js/i18n.js whole costs ~28 MB in every window (heap and source). Built
// from js/i18n.js itself (the table, then its runtime functions verbatim), so it
// can never drift from what the full file says. js/i18n-load.js rides along and
// fetches the rest when a page needs it, from tablesFor() (`/i18n-langs.json`).
//
// Reading the table means running the file's data half once in a sandbox
// (~50 ms for 4 MB). That happens when a window first asks for a language and
// again only after i18n.js changes on disk; the server keeps the built scripts,
// never the whole table.
//
// text() serves the few app strings the server draws itself (the hint over the
// screenshot area picker), from the same table and with the same caching.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = path.join(__dirname, 'js', 'i18n.js');
const LOADER = path.join(__dirname, 'js', 'i18n-load.js');
// Everything before this line is data (`const i18n = {…}` and its
// Object.assign blocks); from here on it is the runtime (t, setLang…).
const RUNTIME_AT = '\nfunction t(key) {';
const FALLBACK = 'en';

const cache = new Map();   // languages key -> script, for one mtime
const texts = new Map();   // string key -> { language -> text }, for one mtime
let cacheMtime = 0;

const langOf = (value) => String(value || '').trim().toLowerCase().split(/[-_;,]/)[0];

// The languages the page may need: the saved one, the browser's (what the page
// falls back to when none is saved), and English. Unknown codes are dropped by
// build() against the table itself.
function wantedLanguages(savedLanguage, acceptLanguage) {
  const out = new Set([FALLBACK]);
  for (const v of [savedLanguage, String(acceptLanguage || '').split(',')[0]]) {
    const code = langOf(v);
    if (/^[a-z]{2,3}$/.test(code)) out.add(code);
  }
  return [...out].sort();
}

function readTable(source) {
  const at = source.indexOf(RUNTIME_AT);
  if (at < 0) throw new Error('layer-i18n: the i18n runtime was not found');
  return { at, table: vm.runInNewContext(source.slice(0, at) + '\ni18n;', Object.create(null), { timeout: 5000 }) };
}

function pick(table, languages) {
  const subset = {};
  for (const code of languages) {
    if (Object.prototype.hasOwnProperty.call(table, code)) subset[code] = table[code];
  }
  return subset;
}

// `preferred` (the saved language) goes first: a page whose own pick (an older
// uiLang) was not served starts in it rather than in English, until the saved
// settings arrive. `loader` is js/i18n-load.js, appended as is.
function build(source, languages, preferred, loader) {
  const { at, table } = readTable(source);
  const first = langOf(preferred);
  const order = languages.includes(first) ? [first, ...languages.filter((c) => c !== first)] : languages;
  return "'use strict';\nconst i18n = " + JSON.stringify(pick(table, order)) + ';'
    + "\nif (typeof lang === 'string' && !i18n[lang]) lang = Object.keys(i18n)[0] || 'en';"
    + source.slice(at) + (loader ? '\n' + loader : '');
}

async function fresh() {
  const { mtimeMs } = await fs.promises.stat(SOURCE);
  if (mtimeMs !== cacheMtime) { cache.clear(); texts.clear(); cacheMtime = mtimeMs; }
}

async function scriptFor(languages, preferred) {
  await fresh();
  const key = languages.join(',') + '>' + langOf(preferred);
  if (!cache.has(key)) {
    if (cache.size >= 16) cache.clear();   // a browser can name any language: keep it bounded
    const [source, loader] = await Promise.all([fs.promises.readFile(SOURCE, 'utf8'), fs.promises.readFile(LOADER, 'utf8')]);
    cache.set(key, build(source, languages, preferred, loader));
  }
  return cache.get(key);
}

// Whole languages as JSON, for js/i18n-load.js. Built per request and not kept:
// a page asks once at most (its first search, a language change), and all
// eleven would be megabytes held for nothing.
async function tablesFor(codes) {
  const wanted = [...new Set((Array.isArray(codes) ? codes : []).slice(0, 16).map(langOf))]
    .filter((c) => /^[a-z]{2,3}$/.test(c));
  if (!wanted.length) return '{}';
  const { table } = readTable(await fs.promises.readFile(SOURCE, 'utf8'));
  return JSON.stringify(pick(table, wanted));
}

// One string in `language`, else English, else ''. Only keys asked for are kept.
async function text(key, language) {
  await fresh();
  if (!texts.has(key)) {
    const { table } = readTable(await fs.promises.readFile(SOURCE, 'utf8'));
    const values = {};
    for (const [code, strings] of Object.entries(table)) {
      if (strings && typeof strings[key] === 'string') values[code] = strings[key];
    }
    texts.set(key, values);
  }
  const values = texts.get(key);
  return values[langOf(language)] || values[FALLBACK] || '';
}

module.exports = { wantedLanguages, build, scriptFor, tablesFor, text };
