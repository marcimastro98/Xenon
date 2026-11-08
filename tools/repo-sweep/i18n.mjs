// App strings in server/js/i18n.js that no code asks for. A key counts as used
// when it is a whole word anywhere outside the string tables (the functions at
// the bottom of i18n.js count). Keys the code builds at runtime
// (t(`deck_err_${code}`)) come back as "maybe" with the pattern.
//
// Removing is guarded three ways: only keys already in the committed file
// (another session may be wiring a new one up right now), a proof that every
// other string of every language is unchanged, and a write that stops if the
// file changed while the sweep ran.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import vm from 'node:vm';
import { setI18nKeys } from '../i18n-set.mjs';
import { builtNamePatterns } from './built-names.mjs';
import { isTestFile } from './files.mjs';

export const I18N_FILE = 'server/js/i18n.js';
// Keys may hold a dot (remote.panel_status) while code also reaches plain keys
// through a property (L.disk_title): both splits count.
const WORDS = [/[A-Za-z0-9_]+/g, /[A-Za-z0-9_.]+/g];
const KEY_CHARS = 'A-Za-z0-9_.';

const codeStart = (source) => {
  const at = source.search(/^function /m);
  return at === -1 ? source.length : at;
};

// The language tables exactly as the browser builds them (spreads and later
// Object.assign overrides included), from the data part of the file.
export function loadTables(source) {
  const ctx = {};
  vm.runInNewContext(`${source.slice(0, codeStart(source))}\nthis.tables = i18n;`, ctx);
  return ctx.tables;
}

export function definedKeys(tables) {
  const keys = new Set();
  for (const table of Object.values(tables)) for (const key of Object.keys(table)) keys.add(key);
  return keys;
}

function wordSet(texts) {
  const words = new Set();
  for (const text of texts.values()) {
    for (const re of WORDS) for (const [w] of text.matchAll(re)) words.add(w.replace(/^\.+|\.+$/g, ''));
  }
  return words;
}

// { unused, onlyTests, maybe } for `keys`, against every text file but the tables.
export function classifyKeys({ keys, texts }) {
  const app = new Map();
  const tests = new Map();
  for (const [rel, text] of texts) {
    if (rel === I18N_FILE) app.set(rel, text.slice(codeStart(text)));
    else (isTestFile(rel) ? tests : app).set(rel, text);
  }
  const appWords = wordSet(app);
  const testWords = wordSet(tests);
  const patterns = builtNamePatterns(app, { nameChars: KEY_CHARS, minStatic: 3 });
  const out = { unused: [], onlyTests: [], maybe: [] };
  for (const key of [...keys].sort()) {
    if (appWords.has(key)) continue;
    const pattern = patterns.find((p) => p.re.test(key));
    if (pattern) out.maybe.push({ key, pattern: pattern.source, example: pattern.example });
    else if (testWords.has(key)) out.onlyTests.push({ key });
    else out.unused.push({ key });
  }
  return out;
}

export function committedKeys(root) {
  const source = execFileSync('git', ['show', `HEAD:${I18N_FILE}`], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return definedKeys(loadTables(source));
}

// Values from two separate vm runs never share identity (weekdays is an array).
function sameValue(a, b) {
  if (typeof a !== typeof b) return false;
  if (typeof a === 'function') return String(a) === String(b);
  if (a && typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return Object.is(a, b);
}

// Pure: the source without `keys`, after proving nothing else moved.
export function removeKeys(source, keys) {
  const before = loadTables(source);
  const { source: next, changes } = setI18nKeys(source, Object.fromEntries(keys.map((k) => [k, null])));
  new vm.Script(next, { filename: I18N_FILE });
  if (next.slice(codeStart(next)) !== source.slice(codeStart(source))) throw new Error('the code after the tables changed');
  const after = loadTables(next);
  const gone = new Set(keys);
  if (Object.keys(after).join() !== Object.keys(before).join()) throw new Error('the list of languages changed');
  for (const [lang, table] of Object.entries(before)) {
    const now = after[lang];
    for (const [key, value] of Object.entries(table)) {
      if (gone.has(key) ? Object.hasOwn(now, key) : !sameValue(now[key], value)) throw new Error(`${lang}.${key} would not be what it should`);
    }
    for (const key of Object.keys(now)) if (!Object.hasOwn(table, key)) throw new Error(`${lang}.${key} would appear`);
  }
  return { source: next, changes };
}

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// Atomic replace, refused when the file is no longer the one the sweep read.
export function writeIfUnchanged(file, expectedHash, content) {
  if (sha256(fs.readFileSync(file)) !== expectedHash) {
    throw new Error(`${file} changed while the sweep ran (another session?): nothing written, run it again`);
  }
  const tmp = `${file}.repo-sweep-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
