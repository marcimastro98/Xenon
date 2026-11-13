// App strings (server/js/i18n/<code>.js, one file per language) that no code
// asks for. A key counts as used when it is a whole word anywhere outside those
// files. Keys the code builds at runtime (t(`deck_err_${code}`)) come back as
// "maybe" with the pattern.
//
// Removing is guarded three ways: only keys already in the committed files
// (another session may be wiring a new one up right now), a proof that every
// other string of every language is unchanged, and a write that stops if a
// file changed while the sweep ran.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { languageFile, LANGS, ownTables, setI18nKeys } from '../i18n-set.mjs';
import { builtNamePatterns } from './built-names.mjs';
import { isTestFile } from './files.mjs';

export { languageFile, LANGS };
// Keys may hold a dot (remote.panel_status) while code also reaches plain keys
// through a property (L.disk_title): both splits count.
const WORDS = [/[A-Za-z0-9_]+/g, /[A-Za-z0-9_.]+/g];
const KEY_CHARS = 'A-Za-z0-9_.';
const LANGUAGE_FILE = /^server\/js\/i18n\/[a-z]{2}\.js$/;

/** Each language's own words, from the text of its file: { code: { key: text } }. */
export const loadTables = ownTables;

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
    if (LANGUAGE_FILE.test(rel)) continue;
    (isTestFile(rel) ? tests : app).set(rel, text);
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

// Every key some language has in the last commit. A language file that is not
// committed yet gives none, so nothing of it can be removed.
export function committedKeys(root, langs = LANGS) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  git(['rev-parse', '--verify', 'HEAD']); // no git or no commit: say so, do not guess
  const texts = {};
  for (const code of langs) {
    try {
      texts[code] = git(['show', `HEAD:${languageFile(code)}`]);
    } catch { /* not committed yet */ }
  }
  return definedKeys(loadTables(texts));
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Pure: the files without `keys`, after proving nothing else moved.
export function removeKeys(texts, keys) {
  const before = loadTables(texts);
  const { texts: next, changes } = setI18nKeys(texts, Object.fromEntries(keys.map((k) => [k, null])));
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
  return { texts: next, changes };
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
