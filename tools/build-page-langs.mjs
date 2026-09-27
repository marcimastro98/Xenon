#!/usr/bin/env node
// Builds the static language copies of the site's pages (not the home: that is
// build-i18n.mjs). For every page in tools/lang-pages.mjs and every language it
// is published in, writes docs/<lang>/<page> with:
//
//   - every [data-i18n] / [data-i18n-html] / [data-i18n-alt] / [data-i18n-aria]
//     element carrying its translation (tools/page-i18n.mjs is the contract);
//   - <html lang>, the title, description and social tags in that language;
//   - the canonical pointed at the copy and the full set of hreflang links;
//   - JSON-LD strings swapped by exact match ("ld." keys);
//   - internal links pointed at the same language where a copy exists, and
//     every relative URL made root-relative (a copy lives one folder down);
//   - the shared header and footer labels baked in, and the language menu
//     linking the copies.
//
// It also rewrites the English page's hreflang set in place, so the root page
// and its copies always point at each other.
//
// A missing translation keeps the English text and is reported; it never
// fails the build (CI would otherwise stop deploying over one untranslated
// sentence). Run:  node tools/build-page-langs.mjs [--check] [page.html ...]
// With --check it only reports and exits non-zero on a problem.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTagged, escText, escAttr, checkPage } from './page-i18n.mjs';
import { LANG_PAGES, OG_LOCALE, HOME_LANGS, langsOf, pathOf, langMenu, readDictFiles } from './lang-pages.mjs';
import { fillGuideNav } from './site-chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const SITE = 'https://xenon-app.com';
const CHECK = process.argv.includes('--check');

// The shared header/footer labels, read out of docs/chrome.js (one table, six
// languages) so the copies are crawled with their own words, not English.
function chromeLabels() {
  const src = fs.readFileSync(path.join(DOCS, 'chrome.js'), 'utf8');
  const m = /var L = (\{[\s\S]*?\});\r?\n/.exec(src);
  return m ? JSON.parse(m[1]) : {};
}

// A page's inline table (`const I18N = { "en": {…}, … };`), for the pages that
// still carry one, merged under the JSON file so the file can add languages
// and the meta./ld. keys.
function readDict(entry) {
  return readDictFiles(entry.dict);
}

function metaSet(s, re, value) {
  return re.test(s) ? s.replace(re, (all, a, b) => a + escAttr(value) + b) : s;
}

function hreflangBlock(page) {
  const langs = langsOf(page);
  const lines = langs.map((l) => `<link rel="alternate" hreflang="${l}" href="${SITE}${pathOf(page, l)}">`);
  lines.push(`<link rel="alternate" hreflang="x-default" href="${SITE}${pathOf(page, 'en')}">`);
  return lines.join('\n');
}

function setHreflang(s, page) {
  s = s.replace(/<link rel="alternate" hreflang="[^"]*" href="[^"]*">\n?/g, '');
  const block = hreflangBlock(page);
  if (/<link rel="canonical"[^>]*>/.test(s)) return s.replace(/(<link rel="canonical"[^>]*>)/, '$1\n' + block);
  return s.replace('</head>', block + '\n</head>');
}

// Internal links for a copy: relative becomes root-relative, and a page that
// exists in this language points at that copy.
function localizeUrls(s, lang) {
  const copies = new Set(LANG_PAGES.filter((p) => langsOf(p.page).includes(lang)).map((p) => p.page));
  const homeHas = HOME_LANGS.includes(lang);
  const fix = (url) => {
    if (!url || /^(https?:|mailto:|tel:|data:|#|javascript:)/i.test(url)) return url;
    let u = url;
    if (!u.startsWith('/')) u = '/' + u.replace(/^\.\//, '');
    const m = /^\/([^?#]*)([?#].*)?$/.exec(u);
    const file = m ? m[1] : '';
    const tail = m && m[2] ? m[2] : '';
    if (file === '' && homeHas) return '/' + lang + '/' + tail;
    if (copies.has(file)) return '/' + lang + '/' + file + tail;
    return u;
  };
  s = s.replace(/(\s(?:href|src|poster)=")([^"]*)(")/g, (all, a, url, b) => a + fix(url) + b);
  s = s.replace(/(\ssrcset=")([^"]*)(")/g, (all, a, set, b) => a + set.split(',').map((part) => {
    const bits = part.trim().split(/\s+/);
    bits[0] = fix(bits[0]);
    return bits.join(' ');
  }).join(', ') + b);
  return s;
}

function swapJsonLd(s, en, tr) {
  const map = new Map();
  for (const [k, v] of Object.entries(en)) if (k.startsWith('ld.') && tr[k]) map.set(String(v), String(tr[k]));
  return s.replace(/(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/g, (all, a, body, b) => {
    let data;
    try { data = JSON.parse(body); } catch { return all; }
    const walk = (v) => {
      if (typeof v === 'string') return map.has(v) ? map.get(v) : v;
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = walk(v[k]); return o; }
      return v;
    };
    return a + JSON.stringify(walk(data)) + b;
  });
}

function bakeChrome(s, lang, labels, page) {
  const L = labels[lang] || {};
  s = s.replace(/(<(\w+)[^>]*\sdata-xl="([^"]+)"[^>]*>)([^<]*)(<\/\2>)/g, (all, open, tag, key, text, close) => (L[key] ? open + escText(L[key]) + close : all));
  s = s.replace(/<details class="xh-lang">[\s\S]*?<\/details>/, langMenu(page, lang));
  return s;
}

function bake(entry, html, dict, lang, labels) {
  const en = dict.en || {};
  const tr = dict[lang] || {};
  const missing = [];
  let s = html;
  const items = findTagged(s).sort((a, b) => b.start - a.start);
  for (const it of items) {
    const v = tr[it.key];
    if (v == null || v === '') { missing.push(it.key); continue; }
    if (it.attr === 'data-i18n-alt' || it.attr === 'data-i18n-aria') {
      const open = s.slice(it.start, it.openEnd);
      const re = new RegExp('(\\s' + it.attrName + '=")[^"]*(")');
      s = s.slice(0, it.start) + open.replace(re, '$1' + escAttr(v) + '$2') + s.slice(it.openEnd);
    } else {
      const inner = it.attr === 'data-i18n-html' ? String(v) : escText(v);
      s = s.slice(0, it.innerStart) + inner + s.slice(it.innerEnd);
    }
  }
  const url = SITE + pathOf(entry.page, lang);
  const title = tr['meta.title'], desc = tr['meta.desc'];
  s = s.replace(/<html lang="[^"]*"/, `<html lang="${lang}"`);
  if (title) s = s.replace(/<title>[\s\S]*?<\/title>/, '<title>' + escText(title) + '</title>');
  if (desc) s = metaSet(s, /(<meta name="description" content=")[^"]*(")/, desc);
  const ogt = tr['meta.ogtitle'] || title, ogd = tr['meta.ogdesc'] || desc;
  if (ogt) { s = metaSet(s, /(<meta property="og:title" content=")[^"]*(")/, ogt); s = metaSet(s, /(<meta name="twitter:title" content=")[^"]*(")/, ogt); }
  if (ogd) { s = metaSet(s, /(<meta property="og:description" content=")[^"]*(")/, ogd); s = metaSet(s, /(<meta name="twitter:description" content=")[^"]*(")/, ogd); }
  s = metaSet(s, /(<meta property="og:url" content=")[^"]*(")/, url);
  s = s.replace(/<meta property="og:locale" content="[^"]*">/, `<meta property="og:locale" content="${OG_LOCALE[lang] || 'en_US'}">`);
  s = s.replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${url}">`);
  s = setHreflang(s, entry.page);
  s = swapJsonLd(s, en, tr);
  s = s.replace(/"inLanguage":\s*"en"/g, `"inLanguage": "${lang}"`);
  s = fillGuideNav(s, entry.page, lang);
  s = localizeUrls(s, lang);
  s = bakeChrome(s, lang, labels, entry.page);
  s = s.replace(/<html lang="([^"]*)"( data-langs="[^"]*")?/, `<html lang="$1" data-langs="${langsOf(entry.page).join(',')}"`);
  return { html: s, missing };
}

let problems = 0;
const labels = chromeLabels();
const ONLY = process.argv.slice(2).filter((a) => !a.startsWith('--'));
for (const entry of LANG_PAGES) {
  if (ONLY.length && !ONLY.includes(entry.page)) continue;
  const src = path.join(DOCS, entry.page);
  if (!fs.existsSync(src)) { console.log(`skip ${entry.page}: no page`); continue; }
  let html = fs.readFileSync(src, 'utf8');
  const crlf = html.includes('\r\n');
  html = html.replace(/\r\n/g, '\n');
  const dict = readDict(entry);
  const ready = langsOf(entry.page).filter((l) => l !== 'en');
  if (entry.dict !== 'inline') {
    const issues = checkPage(html, dict, ready);
    if (issues.length) { problems += issues.length; console.log(`${entry.page}: ${issues.length} problem(s)\n  ` + issues.slice(0, 12).join('\n  ')); }
  }
  // The English page: its own hreflang set, its menu, and the list of copies.
  let enPage = fillGuideNav(setHreflang(html, entry.page), entry.page, 'en');
  enPage = enPage.replace(/<details class="xh-lang">[\s\S]*?<\/details>/, langMenu(entry.page, 'en'));
  enPage = enPage.replace(/<html lang="([^"]*)"( data-langs="[^"]*")?/, `<html lang="$1" data-langs="${langsOf(entry.page).join(',')}"`);
  if (!CHECK && enPage !== html) fs.writeFileSync(src, crlf ? enPage.replace(/\n/g, '\r\n') : enPage);
  for (const lang of entry.langs) {
    if (!ready.includes(lang)) { console.log(`${entry.page} ${lang}: no translation yet`); continue; }
    const { html: out, missing } = bake(entry, enPage, dict, lang, labels);
    if (missing.length) { problems += missing.length; console.log(`${entry.page} ${lang}: ${missing.length} untranslated, kept in English (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''})`); }
    if (CHECK) continue;
    const dir = path.join(DOCS, lang);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, entry.page), out);
  }
  console.log(`${entry.page}: ${ready.length ? ready.join(', ') : 'no copies'}`);
}
if (CHECK && problems) process.exit(1);
