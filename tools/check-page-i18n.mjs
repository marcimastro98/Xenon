#!/usr/bin/env node
// Checks a translatable page against its dictionary (see tools/page-i18n.mjs).
//
//   node tools/check-page-i18n.mjs download.html es,it,ja,ko,zh
//
// Exits non-zero on a missing key, a stale English snapshot, markup that
// differs between English and a translation, or an em-dash in a translation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPage, findTagged } from './page-i18n.mjs';
import { readDictFiles } from './lang-pages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [page, langArg] = process.argv.slice(2);
if (!page) { console.error('usage: check-page-i18n.mjs <page.html> <langs>'); process.exit(2); }
const html = fs.readFileSync(path.join(ROOT, 'docs', page), 'utf8');
const dict = readDictFiles(page.replace(/\.html$/, '').replace(/\//g, '_'));
const langs = (langArg || Object.keys(dict).filter((l) => l !== 'en' && !l.startsWith('_')).join(',')).split(',').filter(Boolean);
const problems = checkPage(html, dict, langs);
const keys = new Set(findTagged(html).map((i) => i.key));
console.log(page + ': ' + keys.size + ' keys, languages ' + langs.join(', '));
if (problems.length) { console.log(problems.slice(0, 60).join('\n')); if (problems.length > 60) console.log('… ' + (problems.length - 60) + ' more'); process.exit(1); }
console.log('ok');
