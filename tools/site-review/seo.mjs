#!/usr/bin/env node
// Reads every page of docs/ the way a crawler does, from the files themselves, and
// lists what would cost it in search: titles and descriptions, canonical and hreflang,
// headings, pictures, structured data, broken links, pages nothing links to, and a
// sitemap that disagrees with the pages. Nothing is sent anywhere and nothing is
// changed, so it can run at any time, before a push above all.
//
//   node tools/site-review/seo.mjs                 the summary, worst first
//   node tools/site-review/seo.mjs --out seo.json  every finding, as data
//   node tools/site-review/seo.mjs --code title-long --code desc-missing
//
// What it cannot see: rankings, impressions and clicks live in Search Console, and a
// page's words can only be read for meaning by someone reading them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LIMITS } from '../page-meta.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCS = path.join(ROOT, 'docs');
export const ORIGIN = 'https://xenon-app.com';
// Not pages for a search engine: the demo is an app, the rest are files or stubs.
const SKIP_DIRS = new Set(['demo', 'images', 'fonts']);
// Written into docs/ by the Pages workflow, so a checkout does not have them: a link
// or a sitemap line pointing there is fine even though no file answers it here.
const BUILT_AT_DEPLOY = ['/maker/', '/demo/'];
// Its rows, and so their ids, are drawn by a script from catalog.json.
const SCRIPT_ANCHORS = new Set(['/catalog/']);
const CJK = new Set(['ja', 'ko', 'zh']);
const META_MIN = { title: 20, desc: 70, cjkTitle: 10, cjkDesc: 35 };
const THIN = { words: 150, cjkChars: 300 };

const decode = (s) => String(s)
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');

function attrs(tag) {
  const out = {};
  const re = /([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = decode(m[2] !== undefined ? m[2] : m[3]);
  return out;
}

const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => attrs(m[0]));

function withoutCode(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, (m) => (/type=["']application\/ld\+json/i.test(m) ? m : ' '))
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template>/gi, ' ');
}

// One page as data. Only what a crawler reads before running any script.
export function pageFacts(html) {
  const clean = withoutCode(html);
  const head = clean.slice(0, Math.max(clean.search(/<\/head>/i), 0));
  const metas = tags(head, 'meta');
  const meta = (key, val) => {
    const m = metas.find((x) => (x[key] || '').toLowerCase() === val);
    return m ? (m.content || '') : null;
  };
  const links = tags(head, 'link');
  const title = (head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const body = clean.slice(Math.max(clean.search(/<body/i), 0));
  const text = decode(body.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  const headings = [...body.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((m) => ({ level: Number(m[1]), text: decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() }));
  const ld = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => {
    try { return { ok: true, data: JSON.parse(m[1]) }; } catch (err) { return { ok: false, error: err.message }; }
  });
  return {
    lang: (html.match(/<html\b[^>]*\blang=["']([^"']+)/i) || [])[1] || null,
    title: title === undefined ? null : decode(title).replace(/\s+/g, ' ').trim(),
    desc: meta('name', 'description'),
    robots: (meta('name', 'robots') || '').toLowerCase(),
    canonical: (links.find((l) => (l.rel || '').toLowerCase() === 'canonical') || {}).href || null,
    hreflang: links.filter((l) => l.hreflang).map((l) => ({ lang: l.hreflang, href: l.href })),
    og: {
      title: meta('property', 'og:title'), description: meta('property', 'og:description'), image: meta('property', 'og:image'),
      url: meta('property', 'og:url'), type: meta('property', 'og:type'), siteName: meta('property', 'og:site_name'),
    },
    twitter: { card: meta('name', 'twitter:card'), image: meta('name', 'twitter:image') },
    viewport: meta('name', 'viewport'),
    headings,
    images: tags(body, 'img'),
    hrefs: tags(body, 'a').map((a) => a.href).filter(Boolean),
    ids: [...clean.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]),
    ld,
    words: text ? text.split(' ').length : 0,
    chars: text.length,
  };
}

const ldTypes = (facts) => {
  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node['@type']) out.push(...[].concat(node['@type']));
    if (node['@graph']) walk(node['@graph']);
  };
  facts.ld.filter((x) => x.ok).forEach((x) => walk(x.data));
  return out;
};

// What is wrong with one page on its own. `url` is its address on the site.
export function pageIssues(f, url) {
  const out = [];
  const add = (level, code, text) => out.push({ level, code, url, text });
  const noindex = /noindex/.test(f.robots);
  if (!f.lang) add('error', 'lang-missing', 'no lang on <html>');
  if (!f.viewport) add('error', 'viewport-missing', 'no viewport meta');
  if (noindex) return out;
  const cjk = CJK.has((f.lang || '').slice(0, 2));
  const tMax = cjk ? LIMITS.cjkTitle : LIMITS.title;
  const dMax = cjk ? LIMITS.cjkDesc : LIMITS.desc;
  const tMin = cjk ? META_MIN.cjkTitle : META_MIN.title;
  const dMin = cjk ? META_MIN.cjkDesc : META_MIN.desc;
  const tLen = [...(f.title || '')].length;
  const dLen = [...(f.desc || '')].length;
  if (!f.title) add('error', 'title-missing', 'no title');
  else if (tLen > tMax) add('warn', 'title-long', `title ${tLen} > ${tMax}: ${f.title}`);
  else if (tLen < tMin) add('warn', 'title-short', `title ${tLen} < ${tMin}: ${f.title}`);
  if (!f.desc) add('error', 'desc-missing', 'no meta description');
  else if (dLen > dMax) add('warn', 'desc-long', `description ${dLen} > ${dMax}`);
  else if (dLen < dMin) add('warn', 'desc-short', `description ${dLen} < ${dMin}: ${f.desc}`);
  if (!f.canonical) add('error', 'canonical-missing', 'no canonical');
  else if (!f.canonical.startsWith(ORIGIN)) add('error', 'canonical-offsite', `canonical ${f.canonical}`);
  else if (f.canonical !== ORIGIN + url) add('error', 'canonical-other', `canonical ${f.canonical} on ${url}`);
  for (const k of ['title', 'description', 'image', 'url', 'type']) {
    if (!f.og[k]) add('warn', 'og-missing', `no og:${k}`);
  }
  if (f.og.url && f.canonical && f.og.url !== f.canonical) add('warn', 'og-url-differs', `og:url ${f.og.url}`);
  if (!f.twitter.card) add('warn', 'twitter-missing', 'no twitter:card');
  const h1 = f.headings.filter((h) => h.level === 1);
  if (h1.length !== 1) add('error', 'h1-count', `${h1.length} h1`);
  if (f.headings.some((h) => !h.text)) add('warn', 'heading-empty', 'an empty heading');
  let prev = 0;
  for (const h of f.headings) {
    if (prev && h.level > prev + 1) add('warn', 'heading-skip', `h${prev} then h${h.level}: ${h.text.slice(0, 50)}`);
    prev = h.level;
  }
  const noAlt = f.images.filter((i) => i.alt === undefined);
  if (noAlt.length) add('error', 'img-no-alt', `${noAlt.length} pictures with no alt, first ${noAlt[0].src}`);
  const noSize = f.images.filter((i) => !i.width || !i.height);
  if (noSize.length) add('warn', 'img-no-size', `${noSize.length} pictures with no width/height, first ${noSize[0].src || noSize[0]['data-src']}`);
  if (f.ld.some((x) => !x.ok)) add('error', 'ld-invalid', 'JSON-LD that does not parse');
  if (!ldTypes(f).length) add('info', 'ld-missing', 'no structured data');
  const thin = cjk ? f.chars < THIN.cjkChars : f.words < THIN.words;
  if (thin) add('warn', 'thin', `${cjk ? f.chars + ' characters' : f.words + ' words'} of text before any script runs`);
  return out;
}

// docs/x/index.html -> /x/, docs/x.html -> /x.html: the address the pages use for themselves.
export function fileToUrl(rel) {
  const p = '/' + rel.split(path.sep).join('/');
  return p.endsWith('/index.html') ? p.slice(0, -'index.html'.length) : p;
}

function urlToFile(url) {
  const clean = decodeURI(url.split('#')[0].split('?')[0]);
  const rel = clean.replace(/^\//, '');
  for (const c of [rel, path.join(rel, 'index.html'), rel + '.html']) {
    if (!c) continue;
    const full = path.join(DOCS, c);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  return clean === '/' ? path.join(DOCS, 'index.html') : null;
}

// A link as an address on the site, or null when it leaves it.
function resolveLink(href, fromUrl) {
  if (/^(mailto:|tel:|javascript:|data:|#)/i.test(href)) return null;
  let u;
  try { u = new URL(href, ORIGIN + fromUrl); } catch { return null; }
  if (u.origin !== ORIGIN) return null;
  return u.pathname + u.hash;
}

const builtAtDeploy = (url) => BUILT_AT_DEPLOY.some((p) => url === p || url === p.slice(0, -1) || url.startsWith(p));

export function siteIssues(pages, sitemap) {
  const out = [];
  const add = (level, code, url, text) => out.push({ level, code, url, text });
  const live = pages.filter((p) => !/noindex/.test(p.facts.robots));
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  for (const key of ['title', 'desc']) {
    const seen = new Map();
    for (const p of live) {
      const v = p.facts[key];
      if (v) seen.set(v, (seen.get(v) || []).concat(p.url));
    }
    for (const [v, urls] of seen) {
      if (urls.length > 1) add('warn', `${key}-duplicate`, urls[0], `same ${key} on ${urls.length} pages (${urls.slice(0, 4).join(', ')}): ${v.slice(0, 70)}`);
    }
  }
  const linked = new Map();
  for (const p of pages) {
    for (const href of p.facts.hrefs) {
      const to = resolveLink(href, p.url);
      if (!to) continue;
      const [target, hash] = to.split('#');
      if (builtAtDeploy(target)) continue;
      const file = urlToFile(target);
      if (!file) { add('error', 'link-broken', p.url, `${href} goes nowhere`); continue; }
      const page = byUrl.get(target) || byUrl.get(target.endsWith('/') ? target : target + '/');
      if (page) {
        if (page.url !== p.url) linked.set(page.url, (linked.get(page.url) || 0) + 1);
        if (hash && !SCRIPT_ANCHORS.has(page.url) && !page.facts.ids.includes(hash)) add('warn', 'anchor-missing', p.url, `${href}: no #${hash} there`);
      }
    }
    for (const img of p.facts.images) {
      const src = img.src && resolveLink(img.src, p.url);
      if (src && !urlToFile(src)) add('error', 'img-broken', p.url, `${img.src} is not there`);
    }
    if (p.facts.og.image && p.facts.og.image.startsWith(ORIGIN) && !urlToFile(p.facts.og.image.slice(ORIGIN.length))) {
      add('error', 'og-image-broken', p.url, `${p.facts.og.image} is not there`);
    }
  }
  for (const p of live) {
    if (p.url !== '/' && !linked.get(p.url)) add('warn', 'orphan', p.url, 'no page links here in its HTML');
    if (!sitemap.has(ORIGIN + p.url)) add('warn', 'sitemap-missing', p.url, 'indexable but not in the sitemap');
    const alt = p.facts.hreflang;
    if (alt.length) {
      if (!alt.some((a) => a.href === ORIGIN + p.url)) add('error', 'hreflang-self', p.url, 'hreflang set leaves this page out');
      if (!alt.some((a) => a.lang === 'x-default')) add('warn', 'hreflang-default', p.url, 'no x-default');
      for (const a of alt) {
        if (!a.href.startsWith(ORIGIN)) continue;
        const other = byUrl.get(a.href.slice(ORIGIN.length));
        if (!other) { add('error', 'hreflang-broken', p.url, `${a.lang} points at ${a.href}, not a page`); continue; }
        if (!other.facts.hreflang.some((b) => b.href === ORIGIN + p.url)) add('error', 'hreflang-oneway', p.url, `${a.href} does not point back`);
        if (a.lang !== 'x-default' && other.facts.lang && other.facts.lang.slice(0, 2) !== a.lang.slice(0, 2)) {
          add('error', 'hreflang-lang', p.url, `${a.href} is marked ${a.lang} but its html says ${other.facts.lang}`);
        }
      }
    }
  }
  for (const loc of sitemap) {
    const url = loc.slice(ORIGIN.length);
    if (builtAtDeploy(url)) continue;
    const p = byUrl.get(url);
    if (!p) { add('error', 'sitemap-dead', url, 'in the sitemap, not a page'); continue; }
    if (/noindex/.test(p.facts.robots)) add('error', 'sitemap-noindex', url, 'in the sitemap but noindex');
  }
  return out;
}

function htmlFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (dir === base && SKIP_DIRS.has(e.name)) continue;
      out.push(...htmlFiles(path.join(dir, e.name), base));
    } else if (e.name.endsWith('.html') && !/^google[0-9a-f]+\.html$/.test(e.name)) {
      out.push(path.relative(base, path.join(dir, e.name)));
    }
  }
  return out;
}

export function audit() {
  const pages = htmlFiles(DOCS).map((rel) => {
    const facts = pageFacts(fs.readFileSync(path.join(DOCS, rel), 'utf8'));
    return { url: fileToUrl(rel), facts };
  });
  const xml = fs.readFileSync(path.join(DOCS, 'sitemap.xml'), 'utf8');
  const sitemap = new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
  const issues = pages.flatMap((p) => pageIssues(p.facts, p.url)).concat(siteIssues(pages, sitemap));
  return { pages, sitemap, issues };
}

function main() {
  const args = process.argv.slice(2);
  const only = args.flatMap((a, i) => (args[i - 1] === '--code' ? [a] : []));
  const outAt = args.indexOf('--out');
  const { pages, sitemap, issues } = audit();
  const shown = only.length ? issues.filter((i) => only.includes(i.code)) : issues;
  const order = { error: 0, warn: 1, info: 2 };
  const groups = new Map();
  for (const i of shown) groups.set(i.code, (groups.get(i.code) || []).concat(i));
  console.log(`${pages.length} pages, ${pages.filter((p) => /noindex/.test(p.facts.robots)).length} noindex, ${sitemap.size} in the sitemap`);
  const sorted = [...groups.entries()].sort((a, b) => order[a[1][0].level] - order[b[1][0].level] || b[1].length - a[1].length);
  for (const [code, list] of sorted) {
    console.log(`\n${list[0].level} ${code}: ${list.length}`);
    for (const i of list.slice(0, only.length ? 200 : 6)) console.log(`  ${i.url}  ${i.text}`);
    if (!only.length && list.length > 6) console.log(`  and ${list.length - 6} more`);
  }
  if (outAt >= 0) fs.writeFileSync(args[outAt + 1], JSON.stringify(shown, null, 1));
  process.exitCode = shown.some((i) => i.level === 'error') ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
