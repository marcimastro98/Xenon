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
  const toc = shown.map((v) => `<li><a href="#v${esc(v.version)}">${esc(v.version)}</a> <span>${dateText(v.date)}</span></li>`).join('');
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
<meta name="theme-color" content="#E4E4E4" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#232323" media="(prefers-color-scheme: dark)">
<link rel="canonical" href="${SITE}/releases.html">
<meta property="og:type" content="website">
<meta property="og:title" content="Xenon releases">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${SITE}/releases.html">
<meta property="og:image" content="${SITE}/images/home/og-card.png">
<meta property="og:locale" content="en_US">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" href="/images/favicon.png">
<script>try{var m=localStorage.getItem('xenon.site.theme');if(m==='light'||m==='dark')document.documentElement.setAttribute('data-theme',m);}catch(e){}</script>
<link rel="stylesheet" href="/site.css">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>
  body { margin: 0; background: var(--g-0); color: var(--bone-0); font: 400 18px/1.6 var(--sans); }
  .rel-main { max-width: 1440px; margin: 0 auto; padding: clamp(40px, 7vh, 88px) 32px 64px; display: grid; grid-template-columns: repeat(12, minmax(0,1fr)); column-gap: 24px; }
  .rel-main > * { grid-column: 1 / span 8; }
  .rel-main h1 { margin: 0; font: 780 clamp(36px, 3.4vw + 10px, 60px)/1.02 var(--display); letter-spacing: -0.016em; }
  .rel-lede a, .rel-main p a { color: var(--bone-0); text-underline-offset: .18em; }
  .rel-lede { margin: 16px 0 0; font-size: 19px; line-height: 1.5; color: var(--bone-1); max-width: 60ch; }
  .rel-toc { list-style: none; margin: 28px 0 8px; padding: 0; display: flex; flex-wrap: wrap; gap: 8px 22px; font-size: 16px; }
  .rel-toc a { font-weight: 700; color: var(--bone-0); }
  .rel-toc span { color: var(--bone-1); margin-left: 4px; }
  .rel { margin-top: clamp(44px, 5vw, 64px); }
  .rel h2 { margin: 0; font: 760 clamp(28px, 1.2vw + 18px, 36px)/1.1 var(--display); letter-spacing: -0.012em; display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
  .rel h2 time { font: 600 16px/1 var(--sans); color: var(--bone-1); letter-spacing: 0; }
  .rel h3 { margin: 22px 0 8px; font: 700 18px/1.3 var(--sans); color: var(--bone-1); }
  .rel-items { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  .rel-items > li { padding: 10px 0; border-top: 1px solid var(--g-2); }
  .rel-items summary { cursor: pointer; font-weight: 650; list-style: none; display: flex; gap: 10px; align-items: baseline; }
  .rel-items summary::-webkit-details-marker { display: none; }
  .rel-items summary::before { content: '+'; flex: 0 0 auto; width: 14px; color: var(--bone-1); font-weight: 700; }
  .rel-items details[open] summary::before { content: '−'; }
  .rel-items details > :not(summary) { margin-left: 24px; }
  .rel-one { padding-left: 24px !important; font-weight: 650; }
  .rel-items summary:hover { text-decoration: underline; text-underline-offset: .18em; }
  .rel-items details p { margin: 10px 0 0; color: var(--bone-1); font-size: 17px; max-width: 70ch; }
  .rel-items details ul { margin: 8px 0 0; color: var(--bone-1); font-size: 17px; }
  .rel-items code { font: 500 .9em/1 var(--mono); }
  /* Changelog notes carry long paths and identifiers; they wrap instead of
     widening the page on a phone. */
  .rel-items { overflow-wrap: anywhere; }
  .rel-older { margin-top: 48px; font-size: 17px; }
  .rel-older a { font-weight: 700; color: var(--bone-0); }
  @media (max-width: 900px) { .rel-main { padding: 36px 18px 48px; display: block; } }
</style>
<script src="/theme.js" defer></script>
<script src="/chrome.js" defer></script>
</head>
<body>

${headerHtml({ lang: false })}

<main class="rel-main">
  ${crumbsHtml('releases.html')}
  <h1>Releases</h1>
  <p class="rel-lede">What changed in each version of Xenon, newest first. The app updates itself; every release and its checksums are also on <a href="https://github.com/marcimastro98/Xenon/releases">GitHub</a>.</p>
  <ul class="rel-toc">${toc}</ul>
${body}
  <p class="rel-older">Older versions, back to the first: <a href="https://github.com/marcimastro98/Xenon/blob/main/CHANGELOG.md">the full changelog on GitHub</a>.</p>
  ${guidesHtml('releases.html')}
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
