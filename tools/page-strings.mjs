#!/usr/bin/env node
// Sets text on a site page in all seven languages in one step: the English in
// the page itself (the source of truth), its "en" snapshot, and each
// translation in tools/i18n/, so no language keeps an old sentence. The
// language copies are then baked by the usual builder:
//
//   node tools/page-strings.mjs patch.json [--check]
//   node tools/build-page-langs.mjs <page.html ...>
//
// patch.json: { "faq.html": { "f.a.temp": { "en": "...", "it": "...", ... } } }
// A key is the element's data-i18n / data-i18n-html name, or an "ld." key: a
// string inside the page's JSON-LD, swapped by exact match of its old English.
// Not for the home (tools/home-i18n.mjs) or titles (tools/page-meta.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANG_PAGES } from './lang-pages.mjs';
import { findTagged, escText } from './page-i18n.mjs';
import { dictFileFor, indentOf } from './page-meta.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tags = (s) => (String(s).match(/<\/?[a-z][a-z0-9]*/gi) || []).map((x) => x.toLowerCase()).join(',');

// Every language present, no em-dash, the same markup as the English.
export function validateStrings(page, set, langs) {
  const errors = [];
  for (const [key, byLang] of Object.entries(set || {})) {
    if (key.startsWith('meta.')) { errors.push(`${page} ${key}: titles go through tools/page-meta.mjs`); continue; }
    for (const l of ['en', ...langs]) {
      const v = byLang && byLang[l];
      if (typeof v !== 'string' || !v.trim()) { errors.push(`${page} ${key} ${l}: missing`); continue; }
      if (/—/.test(v)) errors.push(`${page} ${key} ${l}: em-dash`);
      if (l !== 'en' && tags(v) !== tags(byLang.en)) errors.push(`${page} ${key} ${l}: markup differs from en`);
    }
  }
  return errors;
}

// The English page with one key's text replaced: every element carrying the
// key, or, for an "ld." key, its old English inside the JSON-LD.
export function setPageString(html, key, value, oldEn) {
  if (key.startsWith('ld.')) {
    const enc = (s) => JSON.stringify(s).slice(1, -1);
    if (!oldEn || !html.includes(enc(oldEn))) throw new Error(`${key}: its old English is not in the JSON-LD`);
    return html.split(enc(oldEn)).join(enc(value));
  }
  const items = findTagged(html).filter((it) => it.key === key);
  if (!items.length) throw new Error(`${key}: no element carries it`);
  let out = html;
  // From the end, so earlier offsets stay valid.
  for (const it of items.sort((a, b) => b.innerStart - a.innerStart)) {
    if (it.innerStart == null) throw new Error(`${key}: ${it.attr} is not supported here`);
    const inner = it.attr === 'data-i18n-html' ? value : escText(value);
    out = out.slice(0, it.innerStart) + inner + out.slice(it.innerEnd);
  }
  return out;
}

function writeDicts(dict, set, langs) {
  const files = new Map();
  const load = (f) => { if (!files.has(f)) files.set(f, JSON.parse(fs.readFileSync(f, 'utf8'))); return files.get(f); };
  for (const l of ['en', ...langs]) {
    const d = load(dictFileFor(dict, l));
    d[l] = d[l] || {};
    for (const [key, byLang] of Object.entries(set)) d[l][key] = byLang[l];
  }
  for (const [f, d] of files) fs.writeFileSync(f, JSON.stringify(d, null, indentOf(fs.readFileSync(f, 'utf8'))) + '\n');
}

function applyPage(page, set, entry) {
  const file = path.join(ROOT, 'docs', page);
  const raw = fs.readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  const en = JSON.parse(fs.readFileSync(dictFileFor(entry.dict, 'en'), 'utf8')).en || {};
  let html = raw.replace(/\r\n/g, '\n');
  for (const [key, byLang] of Object.entries(set)) html = setPageString(html, key, byLang.en, en[key]);
  writeDicts(entry.dict, set, entry.langs);
  fs.writeFileSync(file, crlf ? html.replace(/\n/g, '\r\n') : html);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!arg) { console.error('usage: node tools/page-strings.mjs patch.json [--check]'); process.exit(2); }
  const patch = JSON.parse(fs.readFileSync(arg, 'utf8'));
  const entries = {};
  const errors = [];
  for (const [page, set] of Object.entries(patch)) {
    entries[page] = LANG_PAGES.find((p) => p.page === page);
    if (!entries[page]) { errors.push(`${page}: not in LANG_PAGES`); continue; }
    errors.push(...validateStrings(page, set, entries[page].langs));
  }
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  if (process.argv.includes('--check')) { console.log(`ok: ${Object.keys(patch).length} page(s)`); process.exit(0); }
  for (const [page, set] of Object.entries(patch)) {
    applyPage(page, set, entries[page]);
    console.log(`${page}: ${Object.keys(set).length} key(s), ${entries[page].langs.length + 1} languages`);
  }
}
