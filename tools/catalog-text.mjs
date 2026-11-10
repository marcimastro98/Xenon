// The paid packs' descriptions in the site's languages. The hub keeps one English text per
// entry; docs/catalog/text.json holds the translations, each beside the English it was made
// from, so the catalog page can tell when the hub's text changed and show the new English
// instead of an old translation.
//
//   node tools/catalog-text.mjs                 what is missing or out of date
//   node tools/catalog-text.mjs add <file.json> add translations: { "<id>": { "it": "...", ... } }
//
// Reads the catalog from origin/main: the hub writes there, so the copy in a working branch
// can be weeks old.

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEXT_FILE = path.join(ROOT, 'docs', 'catalog', 'text.json');
const NOTE = 'Translations of the paid packs\' descriptions. "en" is the hub text each one was made from: '
  + 'when it no longer matches, the catalog shows the hub text. Managed by tools/catalog-text.mjs.';

export const TEXT_LANGS = ['it', 'es', 'fr', 'ja', 'ko', 'zh'];

const englishOf = (entry) => (typeof entry.description === 'string' ? entry.description.trim() : '');

// Which paid entries have no translation, and which were translated from an older text.
export function reviewText(entries, text) {
  const missing = [];
  const stale = [];
  for (const entry of entries) {
    if (!entry.locked || !englishOf(entry)) continue;
    const own = text[entry.id];
    if (!own) missing.push(entry.id);
    else if (own.en !== englishOf(entry)) stale.push(entry.id);
  }
  return { missing, stale };
}

// The text file with these translations added, each stamped with the English of today.
export function mergeText(entries, text, translations) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const merged = { ...text };
  for (const [id, words] of Object.entries(translations)) {
    const entry = byId.get(id);
    if (!entry) throw new Error(`no entry "${id}" in the catalog`);
    const lacking = TEXT_LANGS.filter((lang) => typeof words[lang] !== 'string' || !words[lang].trim());
    if (lacking.length) throw new Error(`"${id}" lacks ${lacking.join(', ')}`);
    merged[id] = { en: englishOf(entry), ...Object.fromEntries(TEXT_LANGS.map((lang) => [lang, words[lang].trim()])) };
  }
  return merged;
}

function liveEntries() {
  const raw = execFileSync('git', ['show', 'origin/main:docs/community/catalog.json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const data = JSON.parse(raw);
  return Array.isArray(data.entries) ? data.entries : [];
}

async function savedText() {
  try {
    return JSON.parse(await readFile(TEXT_FILE, 'utf8')).entries || {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function main([command, file]) {
  const entries = liveEntries();
  const text = await savedText();
  if (command === 'add') {
    const translations = JSON.parse(await readFile(file, 'utf8'));
    const entriesOut = mergeText(entries, text, translations);
    await writeFile(TEXT_FILE, `${JSON.stringify({ _note: NOTE, entries: entriesOut }, null, 2)}\n`);
    console.log(`${Object.keys(translations).length} added, ${Object.keys(entriesOut).length} in the file`);
    return;
  }
  const { missing, stale } = reviewText(entries, text);
  console.log(`no translation: ${missing.join(', ') || 'none'}`);
  console.log(`hub text changed: ${stale.join(', ') || 'none'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
