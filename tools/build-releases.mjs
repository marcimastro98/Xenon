#!/usr/bin/env node
// Builds docs/releases.html from CHANGELOG.md: what changed in each recent
// version, with its date, so "is this still maintained?" has an answer on the
// site itself. Each change shows its one-line title; the full note opens under
// it. The latest versions are written out; older ones link to GitHub.
//
//   node tools/build-releases.mjs        (the Pages workflow runs it too)
//
// Node builtins only. The shared header and footer come from site-chrome.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { headerHtml, footerHtml, crumbsHtml, guidesHtml } from './site-chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://xenon-app.com';
const KEEP = 12;                       // versions written out in full
// Bit on the edge of the sheet, as on the other pages with no picture to show.
const BIT = '<svg class="pg-bit" viewBox="0 0 8 11" shape-rendering="crispEdges" aria-hidden="true"><path class="bb" d="M4 0h1v2H4zM1 2h6v1H1zM0 3h8v6H0zM1 9h6v1H1zM1 10h2v1H1zM5 10h2v1H5z"/><path class="bf" d="M2 4h1v2H2zM5 4h1v2H5zM2 7h1v1H2zM3 8h2v1H3zM5 7h1v1H5z"/></svg>';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// The changelog's inline markdown: **bold**, `code`, [text](url). Everything
// else is text. An em-dash between words reads as a comma on this site.
function inline(src) {
  let s = esc(src).replace(/\s+—\s+/g, ', ').replace(/—/g, ', ');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return s;
}

function parse(md) {
  const versions = [];
  let v = null, sec = null, item = null, para = [];
  const flushPara = () => { if (item && para.length) item.paras.push(para.join(' ')); para = []; };
  const flushItem = () => { flushPara(); if (item && sec) sec.items.push(item); item = null; };
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    const h2 = /^## \[v?([^\]]+)\]\s*-\s*(\d{2})-(\d{2})-(\d{4})/.exec(raw);
    if (h2) { flushItem(); v = { version: h2[1], date: `${h2[4]}-${h2[3]}-${h2[2]}`, sections: [] }; versions.push(v); sec = null; continue; }
    if (/^## /.test(raw)) { flushItem(); v = null; sec = null; continue; }
    if (!v) continue;
    const h3 = /^### (.+)$/.exec(raw);
    if (h3) { flushItem(); sec = { title: h3[1].replace(/[^\p{L}\p{N}&,\s-]/gu, '').trim(), items: [] }; v.sections.push(sec); continue; }
    if (!sec) continue;
    if (/^- /.test(raw)) { flushItem(); item = { paras: [], sub: [] }; para = [raw.slice(2).trim()]; continue; }
    if (!item) continue;
    if (/^\s{2,}- /.test(raw)) { flushPara(); item.sub.push(raw.trim().slice(2)); continue; }
    if (!raw.trim()) { flushPara(); continue; }
    para.push(raw.trim());
  }
  flushItem();
  return versions;
}

// The title of a change: its leading bold sentence, or its first sentence.
function titleOf(item) {
  const first = item.paras[0] || '';
  const b = /^\*\*(.+?)\*\*\s*/.exec(first);
  if (b) return { title: b[1].replace(/\.$/, ''), rest: first.slice(b[0].length) };
  const m = /^(.{20,140}?[.!?])\s/.exec(first);
  return m ? { title: m[1].replace(/\.$/, ''), rest: first.slice(m[0].length) } : { title: first, rest: '' };
}

function dateText(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function render(versions) {
  const shown = versions.slice(0, KEEP);
  const toc = shown.map((v) => `<a href="#v${esc(v.version)}">${esc(v.version)}<span>${dateText(v.date)}</span></a>`).join('');
  const body = shown.map((v) => {
    const secs = v.sections.map((s) => {
      const items = s.items.map((it) => {
        const { title, rest } = titleOf(it);
        const paras = [rest, ...it.paras.slice(1)].filter((p) => p && p.trim()).map((p) => `<p>${inline(p)}</p>`).join('');
        const sub = it.sub.length ? '<ul>' + it.sub.map((x) => `<li>${inline(x)}</li>`).join('') + '</ul>' : '';
        return paras || sub
          ? `<li><details><summary>${inline(title)}</summary>${paras}${sub}</details></li>`
          : `<li class="rel-one">${inline(title)}</li>`;
      }).join('');
      return `<h3>${esc(s.title)}</h3><ul class="rel-items">${items}</ul>`;
    }).join('');
    return `<section class="rel" id="v${esc(v.version)}" aria-labelledby="h-v${esc(v.version)}"><h2 id="h-v${esc(v.version)}">${esc(v.version)} <time datetime="${v.date}">${dateText(v.date)}</time></h2>${secs}</section>`;
  }).join('\n');
  const latest = shown[0];
  const desc = `What changed in each Xenon version, newest first. Latest: ${latest.version}, released ${dateText(latest.date)}.`;
  const ld = {
    '@context': 'https://schema.org', '@type': 'WebPage', name: 'Xenon releases', url: SITE + '/releases.html',
    description: desc, dateModified: latest.date,
    about: { '@type': 'SoftwareApplication', name: 'Xenon', softwareVersion: latest.version, operatingSystem: 'Windows, macOS (beta), Linux (beta)', applicationCategory: 'UtilitiesApplication' },
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<!-- Generated by tools/build-releases.mjs from CHANGELOG.md. Do not edit by hand. -->
<title>Xenon releases: what changed in each version</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="index, follow">
<meta name="theme-color" content="#FFD75E">
<link rel="canonical" href="${SITE}/releases.html">
<meta property="og:type" content="website">
<meta property="og:title" content="Xenon releases">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${SITE}/releases.html">
<meta property="og:image" content="${SITE}/images/home/og-card.png">
<meta property="og:locale" content="en_US">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" href="/images/favicon.png">
<script>try{var d=document.documentElement,m=localStorage.getItem('xenon.site.theme');if(m==='light'||m==='dark')d.setAttribute('data-theme',m);if(Number(localStorage.getItem('xenon.site.strip.until'))>Date.now()){d.setAttribute('data-strip','');addEventListener('load',function(){d.removeAttribute('data-strip')})}}catch(e){}</script>
<link rel="stylesheet" href="/site.css">
<link rel="stylesheet" href="/guide.css">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>
  /* A version is a heading; each change is a row that opens, as on the help page. */
  .rel { margin-top: clamp(48px, 5vw, 72px); scroll-margin-top: 88px; }
  .rel:first-child { margin-top: 0; }
  .rel h2 { display: flex; flex-wrap: wrap; align-items: baseline; gap: 14px; margin: 0; }
  .rel h2 time { font: 600 16px/1 var(--sans); color: var(--muted); letter-spacing: 0; }
  .rel h3 { margin: 24px 0 6px; font: 700 18px/1.3 var(--sans); color: var(--muted); }
  /* Changelog notes carry long paths and identifiers; they wrap instead of
     widening the page on a phone. */
  .rel-items { margin: 0; padding: 0; list-style: none; overflow-wrap: anywhere; }
  .rel-items > li { margin: 0; border-top: 1px solid var(--line); }
  .rel-items details { border: 0; }
  .rel-items details > summary { padding: 12px 0; font-size: 17px; }
  .rel-items details[open] { padding-bottom: 12px; }
  .rel-items details > :not(summary) { max-width: 70ch; margin-left: 26px; font-size: 17px; }
  .rel-items details > p { margin-bottom: 10px; }
  .rel-items > li.rel-one { padding: 12px 0 12px 26px; color: var(--text); font-size: 17px; font-weight: 650; line-height: 1.4; }
  .rel-older { margin-top: 48px; }
  .jump a span { display: none; }
  @media (min-width: 1181px) { .jump a span { display: inline; margin-left: 10px; font-weight: 400; } }
</style>
<script src="/theme.js" defer></script>
<script src="/chrome.js" defer></script>
</head>
<body data-sheet="yellow">

${headerHtml({ lang: false })}

<main>
<section class="pg" aria-labelledby="pg-h">
  <div class="pg-w">
    <div class="pg-copy">
      ${crumbsHtml('releases.html')}
      <h1 id="pg-h">Releases</h1>
      <p class="lede">What changed in each version of Xenon, newest first. The app updates itself; every release and its checksums are also on <a href="https://github.com/marcimastro98/Xenon/releases">GitHub</a>.</p>
    </div>
    ${BIT}
  </div>
</section>
<div class="pg-body">
  <nav class="jump" aria-labelledby="jump-h">
    <p id="jump-h">Versions</p>
    ${toc}
  </nav>
  <div class="wrap">
${body}
    <p class="rel-older">Older versions, back to the first: <a href="https://github.com/marcimastro98/Xenon/blob/main/CHANGELOG.md">the full changelog on GitHub</a>.</p>
    ${guidesHtml('releases.html')}
  </div>
</div>
</main>

${footerHtml()}

</body>
</html>
`;
}

const md = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const versions = parse(md);
if (!versions.length) { console.log('build-releases: no versions found'); process.exit(0); }
fs.writeFileSync(path.join(ROOT, 'docs', 'releases.html'), render(versions));
console.log(`releases.html: ${Math.min(KEEP, versions.length)} of ${versions.length} versions, latest ${versions[0].version}`);
