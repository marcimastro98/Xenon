'use strict';

// The app's strings as every page loads them, served as `/layer-i18n.js`: the
// saved language and the browser's, plus English for t()'s fallback, not all
// eleven (all of them cost ~28 MB in every window, heap and source). Built from
// the words (js/i18n/<code>.js, read through app-strings/tables.js) and from
// js/i18n.js, whose functions follow verbatim, so a page can never say anything
// the files do not. js/i18n-load.js rides along and fetches the rest when a page
// needs it, from tablesFor() (`/i18n-langs.json`).
//
// A language file is read and run once in a sandbox (a few ms each) when a
// window first asks for it, and again only after a file changes on disk; the
// server keeps the built scripts, never the tables.
//
// text() serves the few app strings the server draws itself (the hint over the
// screenshot area picker), from the same files and with the same caching.

const fs = require('fs');
const path = require('path');
const Tables = require('./app-strings/tables.js');

const CORE = path.join(__dirname, 'js', 'i18n.js');
const LOADER = path.join(__dirname, 'js', 'i18n-load.js');
// From this line on js/i18n.js is the runtime (t, setLang…); what comes before
// is its empty table, which the built script replaces with the real one.
const RUNTIME_AT = '\nfunction t(key) {';
const FALLBACK = Tables.FALLBACK;

const cache = new Map();   // languages key -> script, for one stamp
const texts = new Map();   // string key -> { language -> text }, for one stamp
let cacheStamp = '';

const langOf = (value) => String(value || '').trim().toLowerCase().split(/[-_;,]/)[0];

// The languages the page may need: the saved one, the browser's (what the page
// falls back to when none is saved), and English. Unknown codes are dropped by
// the tables themselves.
function wantedLanguages(savedLanguage, acceptLanguage) {
  const out = new Set([FALLBACK]);
  for (const v of [savedLanguage, String(acceptLanguage || '').split(',')[0]]) {
    const code = langOf(v);
    if (/^[a-z]{2,3}$/.test(code)) out.add(code);
  }
  return [...out].sort();
}

function runtimeOf(core) {
  const at = core.indexOf(RUNTIME_AT);
  if (at < 0) throw new Error('layer-i18n: the i18n runtime was not found');
  return core.slice(at);
}

// `tables` in the order the page should hold them: its first key is the language
// a page starts in when its own pick (an older uiLang) was not served, until the
// saved settings arrive. `core` is js/i18n.js and `loader` js/i18n-load.js,
// appended as they are.
function build(tables, core, loader) {
  return "'use strict';\nconst i18n = " + JSON.stringify(tables) + ';'
    + "\nif (typeof lang === 'string' && !i18n[lang]) lang = Object.keys(i18n)[0] || 'en';"
    + runtimeOf(core) + (loader ? '\n' + loader : '');
}

async function fresh() {
  const [core, words] = await Promise.all([fs.promises.stat(CORE), Tables.stamp()]);
  const stamp = core.mtimeMs + '|' + words;
  if (stamp !== cacheStamp) { cache.clear(); texts.clear(); cacheStamp = stamp; }
}

// `preferred` (the saved language) goes first.
async function scriptFor(languages, preferred) {
  await fresh();
  const key = languages.join(',') + '>' + langOf(preferred);
  if (!cache.has(key)) {
    if (cache.size >= 16) cache.clear();   // a browser can name any language: keep it bounded
    const first = langOf(preferred);
    const order = languages.includes(first) ? [first, ...languages.filter((c) => c !== first)] : languages;
    const [tables, core, loader] = await Promise.all([
      Tables.tables(order), fs.promises.readFile(CORE, 'utf8'), fs.promises.readFile(LOADER, 'utf8'),
    ]);
    cache.set(key, build(tables, core, loader));
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
  return JSON.stringify(await Tables.tables(wanted));
}

// One string in `language`, else English, else ''. Only keys asked for are
// kept, and only in the languages they were asked in.
async function text(key, language) {
  await fresh();
  const asked = langOf(language);
  const code = Tables.isLanguage(asked) ? asked : FALLBACK;
  if (!texts.has(key)) texts.set(key, {});
  const values = texts.get(key);
  for (const c of new Set([code, FALLBACK])) {
    if (Object.prototype.hasOwnProperty.call(values, c)) continue;
    const own = c === FALLBACK ? await Tables.read(c) : await Tables.read(c).catch(() => ({}));
    values[c] = typeof own[key] === 'string' ? own[key] : '';
  }
  return values[code] || values[FALLBACK] || '';
}

module.exports = { wantedLanguages, build, scriptFor, tablesFor, text };
