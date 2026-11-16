// What every static language copy of a site page needs, whichever builder makes
// it (build-page-langs.mjs for the guides, catalog-langs.mjs for the catalog):
// the hreflang set, links pointed at the same language, and the shared header
// labels read out of docs/chrome.js. Node builtins only: CI runs without npm install.

import fs from 'node:fs';
import path from 'node:path';
import { COPY_PAGES, HOME_LANGS, langsOf, pathOf } from './lang-pages.mjs';

export const SITE = 'https://xenon-app.com';

// The shared header/footer labels, read out of docs/chrome.js (one table, six
// languages) so the copies are crawled with their own words, not English.
export function chromeLabels(docsDir) {
  const src = fs.readFileSync(path.join(docsDir, 'chrome.js'), 'utf8');
  const m = /var L = (\{[\s\S]*?\});\r?\n/.exec(src);
  return m ? JSON.parse(m[1]) : {};
}

function hreflangBlock(page) {
  const langs = langsOf(page);
  const lines = langs.map((l) => `<link rel="alternate" hreflang="${l}" href="${SITE}${pathOf(page, l)}">`);
  lines.push(`<link rel="alternate" hreflang="x-default" href="${SITE}${pathOf(page, 'en')}">`);
  return lines.join('\n');
}

export function setHreflang(s, page) {
  s = s.replace(/<link rel="alternate" hreflang="[^"]*" href="[^"]*">\n?/g, '');
  const block = hreflangBlock(page);
  if (/<link rel="canonical"[^>]*>/.test(s)) return s.replace(/(<link rel="canonical"[^>]*>)/, '$1\n' + block);
  return s.replace('</head>', block + '\n</head>');
}

// Internal links for a copy: relative becomes root-relative, and a page that
// exists in this language points at that copy.
export function localizeUrls(s, lang) {
  const copies = new Set(COPY_PAGES.filter((p) => langsOf(p.page).includes(lang)).map((p) => p.page));
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
  // Both quote styles: translated HTML in tools/i18n/*.json uses single quotes
  // (it lives inside a JSON string), and a missed `href='catalog/'` became
  // /zh/catalog/, a 404 Google kept reporting.
  s = s.replace(/(\s(?:href|src|poster)=)(["'])(.*?)\2/g, (all, a, q, url) => a + q + fix(url) + q);
  s = s.replace(/(\ssrcset=")([^"]*)(")/g, (all, a, set, b) => a + set.split(',').map((part) => {
    const bits = part.trim().split(/\s+/);
    bits[0] = fix(bits[0]);
    return bits.join(' ');
  }).join(', ') + b);
  return s;
}

const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The shared header and footer labels (data-xl) written in a language's words.
export function bakeLabels(s, labels) {
  return s.replace(/(<(\w+)[^>]*\sdata-xl="([^"]+)"[^>]*>)([^<]*)(<\/\2>)/g, (all, open, tag, key, text, close) => (labels[key] ? open + escText(labels[key]) + close : all));
}
