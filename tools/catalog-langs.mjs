#!/usr/bin/env node
// Builds the catalog's language copies, docs/<lang>/catalog/index.html.
//
// The catalog translates itself in the browser from its own I18N table, so a
// crawler (an English browser) only ever saw English at /catalog/, and the
// localized addresses Search Console tried were 404s. Each copy is the English
// page with, for its language:
//
//   - the [data-i18n] / [data-i18n-html] / [data-i18n-ph] text baked in;
//   - <html lang>, title, description, social tags, canonical and the full
//     hreflang set (written into the English page too);
//   - the entry index and the structured data in that language;
//   - the shared header labels, and links pointed at the same language;
//   - window.__XENON_SITE_LANG, which the page's runtime starts from.
//
// build-seo.mjs calls it right after it writes the entry list into the English
// page, so the copies always carry the same entries. Run alone:
//   node tools/catalog-langs.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bake, escAttr, escText } from './home-bake.mjs';
import { CATALOG_PAGE, OG_LOCALE, langsOf, pathOf } from './lang-pages.mjs';
import { SITE, chromeLabels, setHreflang, localizeUrls, bakeLabels } from './lang-copy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const PAGE = CATALOG_PAGE.page;
const TABLE_RE = /const I18N = (\{[\s\S]*?\n\});/;

// The page's own table. It is a script literal in a file of this repo, read
// the way the browser reads it.
export function readCatalogTable(html) {
  const m = TABLE_RE.exec(html);
  if (!m) throw new Error('docs/catalog/index.html has no I18N table');
  return vm.runInNewContext('(' + m[1] + ')', Object.create(null), { timeout: 1000 });
}

const fill = (s, n) => String(s).replace('{n}', String(n));

function setMeta(s, re, value) {
  if (!re.test(s)) throw new Error('catalog head is missing ' + re);
  return s.replace(re, (_all, a, b) => a + escAttr(value) + b);
}

function bakeHead(s, lang, t) {
  const url = SITE + pathOf(PAGE, lang);
  s = s.replace(/<title>[^<]*<\/title>/, '<title>' + escText(t['meta.title']) + '</title>');
  s = setMeta(s, /(<meta name="description" content=")[^"]*(")/, t['meta.desc']);
  s = setMeta(s, /(<meta property="og:title" content=")[^"]*(")/, t['meta.title']);
  s = setMeta(s, /(<meta property="og:description" content=")[^"]*(")/, t['meta.desc']);
  s = setMeta(s, /(<meta name="twitter:title" content=")[^"]*(")/, t['meta.title']);
  s = setMeta(s, /(<meta name="twitter:description" content=")[^"]*(")/, t['meta.desc']);
  s = setMeta(s, /(<meta property="og:url" content=")[^"]*(")/, url);
  s = setMeta(s, /(<meta property="og:locale" content=")[^"]*(")/, OG_LOCALE[lang] || 'en_US');
  return s.replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${url}">`);
}

// The structured data names the page in its language; the items keep their names.
function bakeLd(s, lang, t) {
  return s.replace(/(<!-- SEO-LD:START[^>]*-->\s*<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/, (_all, a, body, b) => {
    const data = JSON.parse(body);
    for (const node of data['@graph'] || []) {
      if (node['@type'] !== 'CollectionPage') continue;
      node.url = SITE + pathOf(PAGE, lang);
      node.name = t['meta.title'];
      node.description = t['meta.desc'];
      node.inLanguage = lang;
    }
    return a + '\n' + JSON.stringify(data, null, 2).replace(/</g, '\\u003c') + '\n' + b;
  });
}

// The crawlable list of every entry: heading, label and each kind in this language.
function bakeIndex(s, t) {
  s = s.replace(/(<nav class="seo-index" aria-label=")[^"]*(")/, (_all, a, b) => a + escAttr(t['seo.aria']) + b);
  s = s.replace(/(<nav class="seo-index"[^>]*>\s*<h2)( data-n="(\d+)">)[^<]*(<\/h2>)/, (_all, a, attr, n, b) => a + attr + escText(fill(t['seo.all'], n)) + b);
  return s.replace(/(<span class="k" data-kind="([a-z]+)">)[^<]*(<\/span>)/g, (all, a, kind, b) => (t['k.' + kind] ? a + escText(t['k.' + kind]) + b : all));
}

function bakeBody(s, t, en) {
  const cut = s.indexOf('const I18N = {');
  const end = s.lastIndexOf('<script', cut);
  const { out } = bake(s.slice(0, end), t, en);
  const ph = out.replace(/(<[a-z]+\b[^>]*\sdata-i18n-ph="([^"]+)"[^>]*>)/g, (tag, _open, key) => {
    const v = t[key] != null ? t[key] : en[key];
    return v == null ? tag : tag.replace(/(\splaceholder=")[^"]*(")/, (_all, a, b) => a + escAttr(v) + b);
  });
  return ph + s.slice(end);
}

function htmlLang(s, lang) {
  return s.replace(/<html lang="[^"]*"( data-langs="[^"]*")?/, `<html lang="${lang}" data-langs="${langsOf(PAGE).join(',')}"`);
}

export function catalogCopy(english, lang, table, labels) {
  const t = Object.assign({}, table.en, table[lang]);
  let s = htmlLang(english, lang);
  s = bakeHead(s, lang, t);
  s = bakeLd(s, lang, t);
  s = bakeIndex(bakeBody(s, t, table.en), t);
  s = bakeLabels(s, labels[lang] || {});
  s = localizeUrls(s, lang);
  if (!s.includes('<script src="/theme.js" defer></script>')) throw new Error('catalog has no theme.js tag');
  s = s.replace('<script src="/theme.js" defer></script>',
    `<script>window.__XENON_SITE_LANG = ${JSON.stringify(lang)};</script>\n<script src="/theme.js" defer></script>`);
  return '<!-- Generated by tools/catalog-langs.mjs from docs/catalog/index.html, do not edit by hand. -->\n' + s;
}

export function buildCatalogCopies(docs = DOCS) {
  const src = path.join(docs, 'catalog', 'index.html');
  const raw = fs.readFileSync(src, 'utf8');
  const crlf = raw.includes('\r\n');
  const english = htmlLang(setHreflang(raw.replace(/\r\n/g, '\n'), PAGE), 'en');
  const table = readCatalogTable(english);
  const labels = chromeLabels(docs);
  fs.writeFileSync(src, crlf ? english.replace(/\n/g, '\r\n') : english);
  const built = [];
  for (const lang of CATALOG_PAGE.langs) {
    if (!table[lang]) throw new Error('the catalog has no ' + lang + ' table');
    const dir = path.join(docs, lang, 'catalog');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), catalogCopy(english, lang, table, labels));
    built.push(lang);
  }
  return built;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('catalog copies: ' + buildCatalogCopies().join(', '));
}
