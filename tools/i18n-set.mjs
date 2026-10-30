#!/usr/bin/env node
// Sets app strings in server/js/i18n.js, one value per language, in place.
//
// A key can be defined more than once for a language: in the main block
// (`  it: {`) and again in a later `Object.assign(i18n.it, {...})` block, where
// the last one wins at runtime. Rewriting copy by hand across 11 languages kept
// missing one of them, so this rewrites EVERY definition of the key for that
// language. A key a language does not have yet is added to its main block,
// after the `...i18n.en,` spread when the block has one (otherwise the English
// fallback would overwrite it).
//
// Run:  node tools/i18n-set.mjs <updates.json> [--check]
//   updates.json = { "key": { "it": "...", "en": "...", ... }, "gone": null }
//   A null removes every definition of that key, in every language.
//   --check prints what would change and writes nothing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN_BLOCK = /^ {2}([a-z]{2}): \{\s*$/;
const ASSIGN_BLOCK = /^Object\.assign\(i18n\.([a-z]{2}), \{\s*$/;

// Line ranges that belong to each language: [{ lang, start, end, main }].
export function languageRegions(lines) {
  const regions = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const main = MAIN_BLOCK.exec(line);
    const assign = ASSIGN_BLOCK.exec(line);
    if (main || assign) {
      if (open) { open.end = i; regions.push(open); }
      open = { lang: (main || assign)[1], start: i, end: lines.length, main: Boolean(main) };
      continue;
    }
    if (open && (line === '};' || line === '});')) { open.end = i; regions.push(open); open = null; }
  }
  if (open) regions.push(open);
  return regions;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function keyLine(key) {
  return new RegExp(`^(\\s+)(["']?)${escapeRe(key)}\\2:\\s*(['"])((?:\\\\.|(?!\\3).)*)\\3(,?)\\s*$`);
}

function quote(value, q) {
  if (q === '"') return JSON.stringify(value);
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

// Pure: returns { source, changes } with every update applied.
export function setI18nKeys(source, updates) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const changes = [];
  for (const [key, perLang] of Object.entries(updates)) {
    const re = keyLine(key);
    if (perLang === null) {
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!re.test(lines[i])) continue;
        changes.push({ key, lang: '*', line: i + 1, kind: 'remove' });
        lines.splice(i, 1);
      }
      continue;
    }
    for (const [lang, value] of Object.entries(perLang)) {
      if (typeof value !== 'string') throw new Error(`${key}.${lang}: value must be a string`);
      const regions = languageRegions(lines).filter((r) => r.lang === lang);
      if (!regions.length) throw new Error(`no block for language "${lang}"`);
      let hits = 0;
      for (const r of regions) {
        for (let i = r.start + 1; i < r.end; i++) {
          const m = re.exec(lines[i]);
          if (!m) continue;
          const keyQuote = m[2];
          const next = `${m[1]}${keyQuote}${key}${keyQuote}: ${quote(value, m[3])}${m[5]}`;
          if (next !== lines[i]) changes.push({ key, lang, line: i + 1, kind: 'set' });
          lines[i] = next;
          hits++;
        }
      }
      if (hits) continue;
      const main = regions.find((r) => r.main) || regions[0];
      let at = main.start + 1;
      for (let i = main.start + 1; i < main.end; i++) {
        if (lines[i].trim() === '...i18n.en,') { at = i + 1; break; }
      }
      // Match the block's own key style (the Dutch block quotes its keys).
      const sample = lines.slice(at, main.end).find((l) => /^\s+["']?[a-z0-9_]+["']?:\s*['"]/i.test(l)) || '    k: \'\'';
      const indent = /^(\s+)/.exec(sample)[1];
      const keyQuote = /^\s+"/.test(sample) ? '"' : '';
      const valueQuote = /:\s*"/.test(sample) ? '"' : "'";
      lines.splice(at, 0, `${indent}${keyQuote}${key}${keyQuote}: ${quote(value, valueQuote)},`);
      changes.push({ key, lang, line: at + 1, kind: 'add' });
    }
  }
  return { source: lines.join(eol), changes };
}

function main(argv) {
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node tools/i18n-set.mjs <updates.json> [--check]');
    process.exit(2);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const target = path.join(root, 'server', 'js', 'i18n.js');
  const updates = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { source, changes } = setI18nKeys(fs.readFileSync(target, 'utf8'), updates);
  for (const c of changes) console.log(`${c.kind} ${c.key} [${c.lang}] line ${c.line}`);
  if (argv.includes('--check')) return;
  fs.writeFileSync(target, source, 'utf8');
  console.log(`${changes.length} change(s) written to server/js/i18n.js`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
