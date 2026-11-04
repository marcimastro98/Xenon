#!/usr/bin/env node
// Sets a page's search title and description in all seven site languages in one
// step: the English <head> (title, description, og: and twitter: tags) and every
// translation's meta.title / meta.desc, so no copy keeps an old title. The copies
// themselves are then baked by the usual builders:
//
//   node tools/page-meta.mjs patch.json [--check]
//   node tools/build-i18n.mjs          (the home)
//   node tools/build-page-langs.mjs    (every other page)
//
// patch.json: { "deck.html": { "en": { "title": "...", "desc": "..." }, "it": {...}, ... } }
// "index.html" is the home: its translations live in the page's own I18N tables.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANG_PAGES } from './lang-pages.mjs';
import { patchHomeI18n, LANGS } from './home-i18n.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CJK = new Set(['ja', 'ko', 'zh']);

// Google cuts titles and snippets by pixel width; a CJK character is about two
// Latin ones wide, so those languages get roughly half the characters.
export const LIMITS = { title: 60, desc: 160, cjkTitle: 34, cjkDesc: 100 };

export function validateMeta(page, byLang) {
  const errors = [];
  for (const l of LANGS) {
    const m = byLang && byLang[l];
    if (!m || typeof m.title !== 'string' || !m.title.trim()) { errors.push(`${page} ${l}: missing title`); continue; }
    if (typeof m.desc !== 'string' || !m.desc.trim()) { errors.push(`${page} ${l}: missing desc`); continue; }
    const t = CJK.has(l) ? LIMITS.cjkTitle : LIMITS.title;
    const d = CJK.has(l) ? LIMITS.cjkDesc : LIMITS.desc;
    if ([...m.title].length > t) errors.push(`${page} ${l}: title ${[...m.title].length} > ${t}`);
    if ([...m.desc].length > d) errors.push(`${page} ${l}: desc ${[...m.desc].length} > ${d}`);
    if (/—/.test(m.title + m.desc)) errors.push(`${page} ${l}: em-dash`);
  }
  return errors;
}

const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The English head: every tag that carries the title or the description. The
// twitter: pair is added after twitter:card when the page has none (X falls
// back to og:, other readers do not).
export function setHead(html, { title, desc }) {
  let s = html;
  const need = (re, what) => { if (!re.test(s)) throw new Error(`no ${what}`); };
  need(/<title>[\s\S]*?<\/title>/, '<title>');
  need(/<meta name="description" content="[^"]*">/, 'meta description');
  s = s.replace(/<title>[\s\S]*?<\/title>/, `<title>${text(title)}</title>`);
  s = s.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${attr(desc)}">`);
  s = s.replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${attr(title)}">`);
  s = s.replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${attr(desc)}">`);
  for (const [name, v] of [['twitter:description', desc], ['twitter:title', title]]) {
    const re = new RegExp(`<meta name="${name}" content="[^"]*">`);
    if (re.test(s)) s = s.replace(re, `<meta name="${name}" content="${attr(v)}">`);
    else if (/<meta name="twitter:card" content="[^"]*">/.test(s)) s = s.replace(/(<meta name="twitter:card" content="[^"]*">)/, `$1\n<meta name="${name}" content="${attr(v)}">`);
  }
  return s;
}

// Which dictionary file holds a language: the per-language file when the page
// has one for it, else the page's main file.
function dictFileFor(dict, lang) {
  const own = path.join(ROOT, 'tools', 'i18n', `${dict}.${lang}.json`);
  if (lang !== 'en' && fs.existsSync(own)) {
    try { if (JSON.parse(fs.readFileSync(own, 'utf8'))[lang]) return own; } catch { /* fall through */ }
  }
  return path.join(ROOT, 'tools', 'i18n', `${dict}.json`);
}

function writeDicts(dict, byLang) {
  const files = new Map();
  for (const l of LANGS) {
    const f = dictFileFor(dict, l);
    if (!files.has(f)) files.set(f, JSON.parse(fs.readFileSync(f, 'utf8')));
    const d = files.get(f);
    d[l] = d[l] || {};
    d[l]['meta.title'] = byLang[l].title;
    d[l]['meta.desc'] = byLang[l].desc;
    // An og: override would keep the old words on social cards.
    delete d[l]['meta.ogtitle'];
    delete d[l]['meta.ogdesc'];
  }
  // Keep each file's own indentation, so the diff shows only the changed lines.
  for (const [f, d] of files) fs.writeFileSync(f, JSON.stringify(d, null, indentOf(fs.readFileSync(f, 'utf8'))) + '\n');
}

export function indentOf(json) {
  const m = /^\{\r?\n([ \t]+)"/.exec(json);
  return m ? m[1] : 2;
}

function applyPage(page, byLang) {
  const file = path.join(ROOT, 'docs', page);
  const raw = fs.readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  let html = setHead(raw.replace(/\r\n/g, '\n'), byLang.en);
  if (page === 'index.html') {
    html = html.replace(/("@id": "https:\/\/xenon-app\.com\/#webpage",[\s\S]*?"name": )"[^"]*"/, `$1${JSON.stringify(byLang.en.title)}`);
    const set = { 'meta.title': {}, 'meta.desc': {} };
    for (const l of LANGS) { set['meta.title'][l] = byLang[l].title; set['meta.desc'][l] = byLang[l].desc; }
    html = patchHomeI18n(html, { set });
  } else {
    const entry = LANG_PAGES.find((p) => p.page === page);
    if (!entry) throw new Error(`${page} is not in LANG_PAGES`);
    writeDicts(entry.dict, byLang);
  }
  fs.writeFileSync(file, crlf ? html.replace(/\n/g, '\r\n') : html);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!arg) { console.error('usage: node tools/page-meta.mjs patch.json [--check]'); process.exit(2); }
  const patch = JSON.parse(fs.readFileSync(arg, 'utf8'));
  const errors = Object.entries(patch).flatMap(([p, m]) => validateMeta(p, m));
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  if (process.argv.includes('--check')) { console.log(`ok: ${Object.keys(patch).length} page(s)`); process.exit(0); }
  for (const [page, byLang] of Object.entries(patch)) { applyPage(page, byLang); console.log(`${page}: 7 languages`); }
}
