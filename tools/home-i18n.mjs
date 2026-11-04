#!/usr/bin/env node
// Edits the home page's inline dictionaries (I18N.en ... I18N.zh in docs/index.html)
// from a patch file, so a copy change reaches all seven languages in one step and
// never leaves a key missing in one of them. The English defaults in the markup are
// rewritten from I18N.en; tools/build-i18n.mjs then bakes the other copies.
//
//   node tools/home-i18n.mjs patch.json [--file docs/index.html] [--check]
//
// patch.json: { "set": { "key": { "en": "...", "it": "...", ... } }, "drop": ["key", ...] }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncEnglish } from './home-bake.mjs';

export const LANGS = ['en', 'it', 'es', 'fr', 'ja', 'ko', 'zh'];
const BLOCK = /( {2}I18N\.([a-z]{2}) = \{)([\s\S]*?)(\n {2}\};)/g;

const lineFor = (key, value) => `    ${JSON.stringify(key)}: ${JSON.stringify(value).replace(/<\//g, '<\\/')},`;
const keyLine = (key) => new RegExp(`^ {4}${JSON.stringify(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: .*$`, 'm');

export function validatePatch(patch) {
  const errors = [];
  for (const [key, byLang] of Object.entries(patch.set || {})) {
    for (const l of LANGS) {
      const v = byLang && byLang[l];
      if (typeof v !== 'string' || !v.trim()) errors.push(`${key}: missing ${l}`);
      else if (/—/.test(v)) errors.push(`${key}.${l}: em-dash`);
    }
  }
  return errors;
}

export function patchHomeI18n(src, patch) {
  const errors = validatePatch(patch);
  if (errors.length) throw new Error(errors.join('\n'));
  const seen = new Set();
  const out = src.replace(BLOCK, (all, open, lang, body, close) => {
    if (!LANGS.includes(lang)) return all;
    seen.add(lang);
    let b = body;
    for (const key of patch.drop || []) b = b.replace(new RegExp('\\n' + keyLine(key).source.slice(1), 'm'), '');
    for (const [key, byLang] of Object.entries(patch.set || {})) {
      const line = lineFor(key, byLang[lang]);
      b = keyLine(key).test(b) ? b.replace(keyLine(key), () => line) : `${b.replace(/\s*$/, '')}\n${line}`;
    }
    return open + b + close;
  });
  const missing = LANGS.filter((l) => !seen.has(l));
  if (missing.length) throw new Error(`dictionaries not found: ${missing.join(', ')}`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const fileArg = args.indexOf('--file');
  const file = fileArg >= 0 ? args[fileArg + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'index.html');
  const patchPath = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--file');
  if (!patchPath) { console.error('usage: node tools/home-i18n.mjs patch.json [--file docs/index.html] [--check]'); process.exit(2); }
  const patch = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
  const src = fs.readFileSync(file, 'utf8');
  const out = syncEnglish(patchHomeI18n(src, patch));
  if (args.includes('--check')) { console.log(out === src ? 'unchanged' : 'would change'); process.exit(0); }
  fs.writeFileSync(file, out);
  console.log(`set ${Object.keys(patch.set || {}).length}, dropped ${(patch.drop || []).length} in ${LANGS.length} languages`);
}
