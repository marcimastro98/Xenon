'use strict';

// The strings of the light layer page (layer-lite.html), served as
// `/layer-i18n.js`. A window that only frames Store widgets needs one language,
// plus English for t()'s fallback, not all eleven: js/i18n.js costs ~10 MB in
// every such window. Built from js/i18n.js itself (the table, then its runtime
// functions verbatim), so it can never drift from what the dashboard shows.
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

function build(source, languages) {
  const { at, table } = readTable(source);
  const subset = {};
  for (const code of languages) {
    if (Object.prototype.hasOwnProperty.call(table, code)) subset[code] = table[code];
  }
  return "'use strict';\nconst i18n = " + JSON.stringify(subset) + ';' + source.slice(at);
}

async function fresh() {
  const { mtimeMs } = await fs.promises.stat(SOURCE);
  if (mtimeMs !== cacheMtime) { cache.clear(); texts.clear(); cacheMtime = mtimeMs; }
}

async function scriptFor(languages) {
  await fresh();
  const key = languages.join(',');
  if (!cache.has(key)) {
    if (cache.size >= 16) cache.clear();   // a browser can name any language: keep it bounded
    cache.set(key, build(await fs.promises.readFile(SOURCE, 'utf8'), languages));
  }
  return cache.get(key);
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

module.exports = { wantedLanguages, build, scriptFor, text };
