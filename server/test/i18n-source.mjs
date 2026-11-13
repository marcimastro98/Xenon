// The app's words and their functions as ONE script, for the tests that read
// the strings as text or run them whole. It has the layout the single
// js/i18n.js had: `const i18n = {`, a block per language (`  it: {`, one
// `    key: 'text',` per line, `  },`), then the functions of js/i18n.js from
// `function t(key) {` on. The lines are the ones in server/js/i18n/<code>.js,
// and English completes the other languages as server/app-strings/tables.js
// does for a page, so running it gives the tables a page holds.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const Tables = createRequire(import.meta.url)('../app-strings/tables.js');
const CORE = new URL('../js/i18n.js', import.meta.url);
const RUNTIME_AT = '\nfunction t(key) {';

let whole = null;
let own = null;

// The languages, in the app's order.
export const APP_LANGS = [...Tables.LANGS];

// Each language's OWN words, as its file has them: no English filled in, so a
// test can tell "translated" from "falls back". Read once.
export function appStrings() {
  if (!own) own = Object.fromEntries(APP_LANGS.map((code) => [code, Tables.parse(readFileSync(Tables.fileOf(code), 'utf8'))]));
  return own;
}

// The languages whose own file has this key.
export function languagesWith(key) {
  const tables = appStrings();
  return APP_LANGS.filter((code) => Object.hasOwn(tables[code], key));
}

// [language, text] for every language that says this key in its own words.
export function textsOf(key) {
  const tables = appStrings();
  return languagesWith(key).filter((code) => typeof tables[code][key] === 'string').map((code) => [code, tables[code][key]]);
}

// One language file's `  key: 'text',` lines, set one level deeper.
function block(code) {
  const lines = readFileSync(Tables.fileOf(code), 'utf8').split('\n');
  const from = lines.indexOf('module.exports = {');
  const to = lines.lastIndexOf('};');
  if (from < 0 || to < from) throw new Error(`js/i18n/${code}.js is not in the shape i18n-split writes`);
  return `  ${code}: {\n${lines.slice(from + 1, to).map((line) => `  ${line}`).join('\n')}\n  },`;
}

export function appStringsSource() {
  if (whole) return whole;
  const core = readFileSync(CORE, 'utf8');
  const at = core.indexOf(RUNTIME_AT);
  if (at < 0) throw new Error('js/i18n.js: the line "function t(key) {" was not found');
  whole = `'use strict';\n\nconst i18n = {\n${Tables.LANGS.map(block).join('\n')}\n};\n`
    + '// English completes every other language (server/app-strings/tables.js).\n'
    + `for (const code of Object.keys(i18n)) if (code !== '${Tables.FALLBACK}') i18n[code] = { ...i18n.${Tables.FALLBACK}, ...i18n[code] };\n`
    + core.slice(at);
  return whole;
}
