#!/usr/bin/env node
// Builds one indexable copy of the home page per language.
//
// The home page translates itself in the browser: every [data-i18n] element
// is swapped from the I18N tables at load, and the language comes from the
// stored choice or the browser. That is right for a person and wrong for a
// crawler, which renders the page with an English browser and indexes English
// at every URL — so Spanish, the first language among Xenon's users, was
// never findable in Spanish.
//
// This script reads docs/index.html and writes docs/<lang>/index.html for each
// non-English language with the strings already baked in, <html lang> set,
// the title, description and Open Graph tags translated, the canonical pointed
// at the copy, and a one-line script that tells the runtime which language the
// URL is. Relative links and assets are rewritten to root-relative so a copy
// in a subfolder finds the same files the root does.
//
// Run it after touching docs/index.html:   node tools/build-i18n.mjs
// CI runs it too, before build-seo.mjs, in .github/workflows/pages.yml.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'docs', 'index.html');
const SITE = 'https://xenon-app.com';

const html = fs.readFileSync(SRC, 'utf8');

/* ── Read the dictionaries out of the page itself ─────────────────────────── */

function readTables(src) {
  const tables = {};
  const re = /  I18N\.([a-z]{2}) = \{([\s\S]*?)\n  \};/g;
  let m;
  while ((m = re.exec(src))) tables[m[1]] = new Function('return {' + m[2] + '\n}')();
  return tables;
}

const I18N = readTables(html);
const LANGS = Object.keys(I18N).filter((l) => l !== 'en');
if (!I18N.en) throw new Error('no I18N.en table found in docs/index.html');

/* ── Baking translations into the markup ─────────────────────────────────── */

const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');

// Index of the matching close tag for an element whose open tag ends at `from`.
// Counts nested opens of the same tag so <span><span>…</span></span> resolves.
function findClose(src, tag, from) {
  const re = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'g');
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(src))) {
    if (m[1] === '/') { depth -= 1; if (depth === 0) return m.index; }
    else if (!m[0].endsWith('/>')) depth += 1;
  }
  return -1;
}

function bake(src, dict, fallback) {
  const re = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)\sdata-i18n(-html)?="([^"]+)"([^>]*)>/g;
  let out = '';
  let last = 0;
  let m;
  let baked = 0;
  while ((m = re.exec(src))) {
    const [full, tag, , isHtml, key] = m;
    const openEnd = m.index + full.length;
    const close = findClose(src, tag, openEnd);
    if (close < 0) throw new Error(`no closing </${tag}> for data-i18n "${key}"`);
    const val = dict[key] != null ? dict[key] : fallback[key];
    out += src.slice(last, openEnd);
    if (val != null) { out += isHtml ? val : escText(val); baked += 1; }
    else out += src.slice(openEnd, close);
    last = close;
    re.lastIndex = close;
  }
  out += src.slice(last);
  return { out, baked };
}

/* ── Everything else a copy needs ─────────────────────────────────────────── */

function replaceOnce(src, from, to, what) {
  if (!src.includes(from)) throw new Error(`could not find ${what}`);
  return src.replace(from, to);
}

function rootRelative(src) {
  // src/href/poster in markup, href inside dictionary strings (escaped quotes),
  // and the two relative fetches in the page's own scripts.
  let s = src.replace(/\s(src|href|poster)="(?!\/|#|[a-z][a-z0-9+.-]*:)/g, ' $1="/');
  s = s.replace(/href=\\"(?!\/|#|[a-z][a-z0-9+.-]*:)/g, 'href=\\"/');
  s = s.replace(/fetch\('(?!\/|[a-z][a-z0-9+.-]*:)/g, "fetch('/");
  return s;
}

function build(lang) {
  const dict = I18N[lang];
  const title = dict['meta.title'] || I18N.en['meta.title'];
  const desc = dict['meta.desc'] || I18N.en['meta.desc'];
  const url = `${SITE}/${lang}/`;

  let s = html;
  s = replaceOnce(s, '<html lang="en">', `<html lang="${lang}">`, '<html lang>');
  s = s.replace(/<title>[^<]*<\/title>/, `<title>${escText(title)}</title>`);
  s = s.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${escAttr(desc)}">`);
  s = s.replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${escAttr(title)}">`);
  s = s.replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${escAttr(desc)}">`);
  s = s.replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${url}">`);
  s = s.replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${url}">`);
  if (!s.includes(`hreflang="${lang}"`)) throw new Error(`docs/index.html has no hreflang entry for ${lang}`);

  const { out, baked } = bake(s, dict, I18N.en);
  s = rootRelative(out);

  // The runtime reads this before it picks a language; see the I18N engine.
  s = replaceOnce(s, '<script src="/theme.js" defer></script>',
    `<script>window.__XENON_SITE_LANG = ${JSON.stringify(lang)};</script>\n<script src="/theme.js" defer></script>`,
    'the theme.js script tag');

  s = `<!-- Generated by tools/build-i18n.mjs from docs/index.html — do not edit by hand. -->\n` + s;

  const dir = path.join(ROOT, 'docs', lang);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), s);
  return baked;
}

for (const lang of LANGS) {
  const n = build(lang);
  console.log(`docs/${lang}/index.html: ${n} strings baked`);
}
