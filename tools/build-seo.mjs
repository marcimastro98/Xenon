#!/usr/bin/env node
// Builds the crawlable surface of xenon-app.com from the data that already
// drives the site, so nothing has to be kept in sync by hand:
//
//   docs/sitemap.xml             every indexable URL, with a real lastmod
//   docs/catalog/<id>/index.html one static page per catalog entry
//
// Why the per-entry pages exist: /catalog/ renders 45 community items from
// catalog.json into hash fragments (/catalog/#demonic). A fragment is not a URL
// a crawler can index, so every one of those items was invisible to search and
// to the AI crawlers that read HTML without running scripts. These pages give
// each item a real address with the same facts on it, and hand the visitor back
// to the interactive catalog to copy the code.
//
// Run it after touching catalog.json:  node tools/build-seo.mjs
// CI runs it too — see the "Build SEO surface" step in .github/workflows/pages.yml —
// so a bot commit that edits the catalog republishes with the pages regenerated.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const SITE = 'https://xenon-app.com';
const SHOTS = 'https://assets.xenon-app.com/community/shots/';
const REPO = 'https://github.com/marcimastro98/Xenon';
const DISCORD = 'https://discord.gg/MBVrw9kZyg';

// Screenshots are uploaded as .webp with a .png fallback the catalog resolves at
// runtime (see shotUrl in docs/catalog/index.html). A social scraper cannot do
// that fallback, so og:image points at the .webp — the primary of the two.
const shotUrl = (id, i, ext = 'webp') =>
  SHOTS + encodeURIComponent(id) + (i === 1 ? '' : '-' + i) + '.' + ext;

/* ── helpers ─────────────────────────────────────────────────────────────── */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// JSON-LD sits inside <script>, where the HTML parser ends the block at the
// first "</script" in the raw text. Escaping "<" keeps a description that
// contains markup from truncating the whole graph.
const ld = (obj) => JSON.stringify(obj, null, 2).replace(/</g, '\\u003c');

// Collapse to a single line and cut on a word boundary — meta descriptions are
// truncated around 160 chars, and a clean cut reads better than an ellipsis
// dropped mid-word.
function clamp(text, max = 158) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, '') + '…';
}

// lastmod is only worth emitting when it is true. Git knows when a file really
// changed; when it cannot say (shallow clone, untracked file), the entry ships
// without a lastmod rather than with today's date, which would tell every
// crawler the whole site changes daily.
function gitDate(relPath) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', relPath], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || '';
  } catch { return ''; }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const isoDay = (s) => (DATE_RE.test(String(s || '')) ? String(s).slice(0, 10) : '');

// Mirror of visible() in docs/catalog/index.html: `active` hard-overrides,
// otherwise the [activeFrom, activeUntil] window decides. An entry outside its
// window is still built (shared links must not rot) but ships noindex and stays
// out of the sitemap.
function visible(e, now = Date.now()) {
  if (!e) return false;
  if (e.active === false) return false;
  if (e.active === true) return true;
  const from = Date.parse(e.activeFrom || '');
  if (Number.isFinite(from) && now < from) return false;
  const until = Date.parse(e.activeUntil || '');
  if (Number.isFinite(until) && now > until) return false;
  return true;
}

// Same wording the catalog UI shows, so the static page and the app agree.
const KIND_LABEL = {
  theme: 'Theme', bg: 'Background', page: 'Page', deck: 'Deck profile',
  widget: 'Widget', bundle: 'Package', ambient: 'Ambient scene',
  icons: 'Icon pack', sounds: 'Sound pack',
};
const CAT_LABEL = {
  deck: 'Deck', streaming: 'Streaming', media: 'Media', 'smart-home': 'Smart home',
  system: 'System', style: 'Style', fun: 'Fun', tools: 'Tools',
};

// A widget, Deck profile or package is software; a theme, background or ambient
// scene is not. Claiming SoftwareApplication for a colour palette would be a
// structured-data mismatch, and mismatches are what get a site's rich results
// pulled — so the type follows what the thing actually is.
const SOFTWARE_KINDS = new Set(['widget', 'deck', 'bundle']);

/* ── the per-entry page ──────────────────────────────────────────────────── */

const PAGE_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#070808;--panel:rgba(240,243,241,.04);--line:rgba(240,243,241,.10);
--green:#1ed760;--gold:#ffc44d;--iris:#8b7bff;--text:#f0f3f1;--muted:#9aa8a1;--dim:#66736c;
--sans:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif}
html{-webkit-text-size-adjust:100%}
body{font-family:var(--sans);background:var(--ink);color:var(--text);line-height:1.6;font-size:16px;
-webkit-font-smoothing:antialiased}
a{color:inherit}
img{max-width:100%;display:block}
:focus-visible{outline:2px solid var(--green);outline-offset:3px;border-radius:4px}
.wrap{width:100%;max-width:880px;margin-inline:auto;padding:0 24px}
header.top{border-bottom:1px solid var(--line)}
header.top .wrap{display:flex;align-items:center;gap:14px;height:64px}
.logo{display:flex;align-items:center;gap:9px;font-weight:700;letter-spacing:.10em;font-size:17px;text-decoration:none}
.logo img{height:28px;width:auto;mix-blend-mode:screen}
.top-cta{margin-left:auto;font-size:14px;color:var(--muted);text-decoration:none}
.top-cta:hover{color:var(--text)}
nav.crumb{font-size:13px;color:var(--dim);padding:22px 0 0}
nav.crumb a{color:var(--muted);text-decoration:none}
nav.crumb a:hover{color:var(--green)}
main{padding-bottom:72px}
.tier{display:inline-block;font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;
color:var(--green);margin:26px 0 10px}
.tier.locked{color:var(--gold)}
.tier.limited{color:var(--iris)}
h1{font-size:clamp(30px,5vw,44px);line-height:1.12;letter-spacing:-.02em;font-weight:800}
.by{color:var(--muted);margin-top:10px;font-size:15px}
.by b{color:var(--text);font-weight:600}
.meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}
.chip{border:1px solid var(--line);background:var(--panel);border-radius:999px;padding:4px 12px;
font-size:13px;color:var(--muted)}
.desc{margin-top:22px;font-size:17px;color:#d4dcd7;max-width:66ch}
.shots{margin-top:28px;display:grid;gap:14px}
.shots img{border:1px solid var(--line);border-radius:12px;width:100%;background:var(--panel)}
.sec{margin-top:34px}
.sec h2{font-size:13px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-bottom:10px}
.sec p{color:#c6cfca;max-width:66ch}
.sw{display:flex;flex-wrap:wrap;gap:14px}
.sw span{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums}
.sw i{width:15px;height:15px;border-radius:4px;border:1px solid var(--line);display:block}
.tags{display:flex;flex-wrap:wrap;gap:8px}
.tags span{font-size:13px;color:var(--dim)}
.cta{margin-top:36px;display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.btn{display:inline-flex;align-items:center;gap:9px;border-radius:11px;padding:13px 20px;font-weight:600;
font-size:15px;text-decoration:none;border:1px solid var(--line);background:var(--panel);color:var(--text)}
.btn.fill{background:var(--green);border-color:var(--green);color:#052012}
.btn:hover{border-color:rgba(240,243,241,.24)}
.note{margin-top:14px;font-size:14px;color:var(--dim);max-width:62ch}
footer{border-top:1px solid var(--line);padding:26px 0;color:var(--dim);font-size:14px}
footer a{color:var(--muted);text-decoration:none}
footer a:hover{color:var(--green)}
@media(min-width:720px){.shots{grid-template-columns:1fr 1fr}.shots img:first-child{grid-column:1/-1}}
`.trim();

function entryPage(e, indexable) {
  const url = `${SITE}/catalog/${encodeURIComponent(e.id)}/`;
  const kindLabel = KIND_LABEL[e.kind] || e.kind;
  const catLabel = e.category ? (CAT_LABEL[e.category] || e.category) : '';
  const locked = e.locked === true || e.supportersOnly === true;
  const limited = e.limited && typeof e.limited === 'object' ? e.limited : null;
  const soldOut = limited ? Number(limited.claimed) >= Number(limited.total) : false;
  const shots = Number.isInteger(e.shots) ? Math.max(0, Math.min(8, e.shots)) : 0;
  const published = isoDay(e.addedAt);
  const modified = isoDay(e.updatedAt) || published;

  const title = `${e.name} — ${kindLabel} for Xenon`;
  const description = clamp(
    e.description ||
    `${e.name}, a ${kindLabel.toLowerCase()} for the Xenon dashboard by ${e.author}. Import it into your local Xenon in one paste.`
  );
  const image = shots > 0 ? shotUrl(e.id, 1) : `${SITE}/images/overview.png`;

  /* ── structured data ── */
  const graph = [];
  const work = {
    '@type': SOFTWARE_KINDS.has(e.kind) ? 'SoftwareApplication' : 'CreativeWork',
    '@id': url + '#item',
    name: e.name,
    url,
    description: (e.description || description).replace(/\s+/g, ' ').trim(),
    inLanguage: 'en',
    author: { '@type': 'Person', name: e.author },
    isPartOf: { '@id': `${SITE}/catalog/#catalog` },
    image,
  };
  if (SOFTWARE_KINDS.has(e.kind)) {
    work.applicationCategory = 'DesktopApplication';
    work.operatingSystem = 'Windows 10, Windows 11';
    // The item runs inside Xenon, not on its own — say so rather than let it
    // read as a standalone download.
    work.softwareRequirements = e.appVersionMin ? `Xenon ${e.appVersionMin} or later` : 'Xenon';
  } else {
    work.genre = kindLabel;
  }
  if (e.version) work.version = e.version;
  if (published) work.datePublished = published;
  if (modified) work.dateModified = modified;
  if (Array.isArray(e.tags) && e.tags.length) work.keywords = e.tags.join(', ');
  if (limited) {
    // A reservation-only drop is neither free nor priced — availability is the
    // only honest claim, so it carries no price and no rating (there is no
    // rating data anywhere in the catalog to report).
    work.isAccessibleForFree = false;
    work.offers = {
      '@type': 'Offer',
      availability: soldOut ? 'https://schema.org/SoldOut' : 'https://schema.org/LimitedAvailability',
      url: (limited.reserveUrl && String(limited.reserveUrl)) || DISCORD,
    };
  } else if (locked) {
    work.isAccessibleForFree = false;
  } else {
    work.isAccessibleForFree = true;
    work.offers = {
      '@type': 'Offer', price: '0', priceCurrency: 'USD',
      availability: 'https://schema.org/InStock', url,
    };
  }
  graph.push(work);
  graph.push({
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Xenon', item: SITE + '/' },
      { '@type': 'ListItem', position: 2, name: 'Community catalog', item: SITE + '/catalog/' },
      { '@type': 'ListItem', position: 3, name: e.name, item: url },
    ],
  });

  /* ── body ── */
  const shotTags = [];
  for (let i = 1; i <= shots; i++) {
    shotTags.push(
      // webp first, png second, gone third — the same two-step the catalog does
      // at runtime, plus the removal, because a broken-image icon sitting in the
      // layout looks worse than the gap it leaves.
      `<img src="${esc(shotUrl(e.id, i))}" alt="${esc(e.name)} — screenshot ${i} of ${shots}"` +
      ` loading="${i === 1 ? 'eager' : 'lazy'}" decoding="async"` +
      ` onerror="this.onerror=function(){this.remove()};this.src='${esc(shotUrl(e.id, i, 'png'))}'">`
    );
  }

  const chips = [];
  if (e.version) chips.push(`v${esc(e.version)}`);
  if (catLabel) chips.push(esc(catLabel));
  if (e.appVersionMin) chips.push(`Xenon ${esc(e.appVersionMin)}+`);
  if (published) chips.push(`Added ${esc(published)}`);

  const swatches = e.preview
    ? ['accent', 'bg', 'text']
        .filter((k) => e.preview[k])
        .map((k) => `<span><i style="background:${esc(e.preview[k])}"></i>${esc(e.preview[k])}</span>`)
        .join('')
    : '';

  const tier = limited ? 'limited' : locked ? 'locked' : '';
  const tierText = limited ? 'Limited edition' : locked ? 'Supporters' : kindLabel;

  // Internal links stay root-relative so the page is correct on the production
  // domain, on the github.io mirror and in a local preview alike.
  const inCatalog = `/catalog/#${encodeURIComponent(e.id)}`;
  let buttons, note;
  if (limited && soldOut) {
    buttons = `<a class="btn" href="${inCatalog}">See it in the catalog</a>`;
    note = `Sold out — all ${esc(limited.total)} copies of this drop are claimed.`;
  } else if (limited) {
    buttons =
      `<a class="btn fill" href="${esc(limited.reserveUrl || DISCORD)}" rel="noopener">Reserve on Discord</a>` +
      `<a class="btn" href="${inCatalog}">Open in the catalog</a>`;
    note = `A limited drop: ${esc(limited.total)} copies, ` +
      `${Math.max(0, Number(limited.total) - Number(limited.claimed))} left. ` +
      `Discord verifies your account and sends a personal access code.`;
  } else if (locked) {
    buttons = `<a class="btn fill" href="${inCatalog}">Open in the catalog</a>`;
    note = `A supporters' item — unlock it in the catalog, then paste the code into ` +
      `Xenon under Settings → Widgets &amp; sharing → Import.`;
  } else {
    buttons =
      `<a class="btn fill" href="${inCatalog}">Copy the code in the catalog</a>` +
      `<a class="btn" href="/">Get Xenon</a>`;
    note = `Free. Copy the share code, then paste it into Xenon under ` +
      `Settings → Widgets &amp; sharing → Import. Everything stays on your machine.`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta name="robots" content="${indexable
    ? 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
    : 'noindex, follow'}">
<meta name="theme-color" content="#070808">
<link rel="icon" type="image/png" href="/images/favicon.png">

<meta property="og:type" content="${SOFTWARE_KINDS.has(e.kind) ? 'product' : 'article'}">
<meta property="og:site_name" content="Xenon">
<meta property="og:locale" content="en_US">
<meta property="og:url" content="${esc(url)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:alt" content="${esc(e.name)} running in the Xenon dashboard">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">

<link rel="preconnect" href="https://assets.xenon-app.com" crossorigin>
<style>${PAGE_CSS}</style>
<script type="application/ld+json">
${ld({ '@context': 'https://schema.org', '@graph': graph })}
</script>
</head>
<body>

<header class="top">
  <div class="wrap">
    <a class="logo" href="/"><img src="/images/logo.png" alt="" width="42" height="28"> XENON</a>
    <a class="top-cta" href="/catalog/">All community items →</a>
  </div>
</header>

<div class="wrap">
  <nav class="crumb" aria-label="Breadcrumb">
    <a href="/">Xenon</a> / <a href="/catalog/">Community catalog</a> / ${esc(e.name)}
  </nav>

  <main>
    <p class="tier${tier ? ' ' + tier : ''}">${esc(tierText)}</p>
    <h1>${esc(e.name)}</h1>
    <p class="by">${esc(kindLabel)} for the Xenon dashboard, by <b>${esc(e.author)}</b></p>
    ${chips.length ? `<div class="meta">${chips.map((c) => `<span class="chip">${c}</span>`).join('')}</div>` : ''}
    ${e.description ? `<p class="desc">${esc(e.description)}</p>` : ''}
    ${shotTags.length ? `<div class="shots">${shotTags.join('')}</div>` : ''}
    ${e.changelog ? `<section class="sec"><h2>What's in it</h2><p>${esc(e.changelog)}</p></section>` : ''}
    ${swatches ? `<section class="sec"><h2>Palette</h2><div class="sw">${swatches}</div></section>` : ''}
    ${Array.isArray(e.tags) && e.tags.length
      ? `<section class="sec"><h2>Tags</h2><div class="tags">${e.tags.map((t) => `<span>#${esc(t)}</span>`).join('')}</div></section>`
      : ''}
    ${e.perfWarning
      ? `<p class="note">This one asks a little more of the machine than most — it is worth knowing before you load it onto a small screen.</p>`
      : ''}
    <div class="cta">${buttons}</div>
    <p class="note">${note}</p>
  </main>
</div>

<footer>
  <div class="wrap">
    <a href="/">Xenon</a> · <a href="/catalog/">Catalog</a> · <a href="/create/">Make your own</a> ·
    <a href="/submit/">Publish yours</a> · <a href="${REPO}" rel="noopener">GitHub</a>
    ${modified ? `<span> · Updated ${esc(modified)}</span>` : ''}
  </div>
</footer>

</body>
</html>
`;
}

/* ── the catalog's crawlable index ───────────────────────────────────────── */

// Without this the 45 per-entry pages are orphans: reachable from sitemap.xml
// and nothing else. A sitemap tells a crawler a URL exists; internal links are
// what tell it the URL matters, and an orphan page ranks like one.
function catalogIndexBlock(live) {
  const items = live.map((e) =>
    `      <li><a href="/catalog/${encodeURIComponent(e.id)}/">${esc(e.name)}</a> ` +
    `<span class="k">${esc(KIND_LABEL[e.kind] || e.kind)}</span></li>`
  ).join('\n');
  return `  <nav class="seo-index" aria-label="All community items">
    <h2>All ${live.length} community items</h2>
    <ul>
${items}
    </ul>
  </nav>`;
}

// The ItemList mirrors the same order the links are in, so the markup and the
// page agree — a mismatch between the two is what structured-data testing flags.
function catalogGraph(live) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        '@id': `${SITE}/catalog/#catalog`,
        url: `${SITE}/catalog/`,
        name: 'Xenon community catalog',
        description: 'Themes, animated backgrounds, dashboard pages, Deck profiles, widgets, ' +
          'ambient scenes and full packages made and shared by the Xenon community.',
        inLanguage: 'en',
        isPartOf: { '@id': `${SITE}/#website` },
        about: { '@id': `${SITE}/#app` },
        publisher: { '@id': `${SITE}/#org` },
        mainEntity: { '@id': `${SITE}/catalog/#items` },
      },
      {
        '@type': 'ItemList',
        '@id': `${SITE}/catalog/#items`,
        name: 'Xenon community catalog',
        numberOfItems: live.length,
        itemListOrder: 'https://schema.org/ItemListUnordered',
        itemListElement: live.map((e, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: e.name,
          url: `${SITE}/catalog/${encodeURIComponent(e.id)}/`,
        })),
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${SITE}/catalog/#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Xenon', item: SITE + '/' },
          { '@type': 'ListItem', position: 2, name: 'Community catalog', item: SITE + '/catalog/' },
        ],
      },
    ],
  };
}

// Both blocks are written between markers so this can run over its own output
// as many times as the catalog changes without the file growing a copy each time.
function patchCatalogPage(live) {
  const file = path.join(DOCS, 'catalog', 'index.html');
  let html = fs.readFileSync(file, 'utf8');

  const patch = (name, replacement) => {
    const re = new RegExp(
      `([ \\t]*<!-- ${name}:START[^>]*-->)[\\s\\S]*?([ \\t]*<!-- ${name}:END -->)`
    );
    if (!re.test(html)) throw new Error(`catalog/index.html is missing the ${name} markers`);
    html = html.replace(re, (_, start, end) => `${start}\n${replacement}\n${end}`);
  };

  patch('SEO-INDEX', catalogIndexBlock(live));
  patch('SEO-LD', `<script type="application/ld+json">\n${ld(catalogGraph(live))}\n</script>`);

  fs.writeFileSync(file, html);
}

/* ── sitemap ─────────────────────────────────────────────────────────────── */

// /get/ and /community/ are deliberately absent: the first is a share-code
// viewer with no content of its own, the second a redirect stub. Both carry
// noindex, and a sitemap that lists noindexed URLs is a Search Console warning.
const STATIC_ROUTES = [
  { loc: '/', file: 'docs/index.html', priority: '1.0', changefreq: 'weekly' },
  { loc: '/catalog/', file: 'docs/community/catalog.json', priority: '0.9', changefreq: 'daily' },
  { loc: '/create/', file: 'docs/create/index.html', priority: '0.8', changefreq: 'monthly' },
  // These three carry `robots: index, follow` and a canonical of their own, so
  // they were always meant to be found — they were simply never listed here,
  // which left the two pages that answer real search queries ("is Xenon a
  // virus", "use a phone as a second screen") out of the only file that tells
  // Google they exist.
  { loc: '/faq.html', file: 'docs/faq.html', priority: '0.7', changefreq: 'monthly' },
  { loc: '/phone.html', file: 'docs/phone.html', priority: '0.7', changefreq: 'monthly' },
  { loc: '/demo/', file: 'docs/demo/index.html', priority: '0.7', changefreq: 'monthly' },
  { loc: '/submit/', file: 'docs/submit/index.html', priority: '0.5', changefreq: 'monthly' },
  { loc: '/privacy.html', file: 'docs/privacy.html', priority: '0.3', changefreq: 'yearly' },
];

function sitemap(urls) {
  const body = urls.map((u) => {
    const lines = [`    <loc>${esc(SITE + u.loc)}</loc>`];
    if (u.lastmod) lines.push(`    <lastmod>${u.lastmod}</lastmod>`);
    if (u.changefreq) lines.push(`    <changefreq>${u.changefreq}</changefreq>`);
    if (u.priority) lines.push(`    <priority>${u.priority}</priority>`);
    return `  <url>\n${lines.join('\n')}\n  </url>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by tools/build-seo.mjs — do not edit by hand. -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9 http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">
${body}
</urlset>
`;
}

/* ── build ───────────────────────────────────────────────────────────────── */

function main() {
  const catalogPath = path.join(DOCS, 'community', 'catalog.json');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const entries = Array.isArray(catalog.entries) ? catalog.entries : [];
  const now = Date.now();

  const urls = STATIC_ROUTES.map((r) => ({
    loc: r.loc, lastmod: gitDate(r.file), changefreq: r.changefreq, priority: r.priority,
  }));

  const built = new Set();
  const live = [];
  let indexed = 0;

  for (const e of entries) {
    // The id is the directory name and rides into URLs — anything outside the
    // catalog's own id shape is a path-traversal risk, not a catalog entry.
    if (!e || typeof e.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,60}$/.test(e.id)) {
      console.warn(`  skipped: unusable id ${JSON.stringify(e && e.id)}`);
      continue;
    }
    if (!e.name || !e.author || !e.kind) {
      console.warn(`  skipped ${e.id}: missing name/author/kind`);
      continue;
    }
    const isLive = visible(e, now);
    const dir = path.join(DOCS, 'catalog', e.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), entryPage(e, isLive));
    built.add(e.id);
    if (isLive) {
      indexed++;
      live.push(e);
      urls.push({
        loc: `/catalog/${encodeURIComponent(e.id)}/`,
        lastmod: isoDay(e.updatedAt) || isoDay(e.addedAt) || '',
        changefreq: 'monthly',
        priority: e.featured ? '0.8' : '0.6',
      });
    }
  }

  // An entry pulled from catalog.json leaves a page behind that says something
  // the catalog no longer does. Sweep those, but only directories this script
  // owns — /catalog/index.html and anything hand-made stays put.
  const catalogDir = path.join(DOCS, 'catalog');
  for (const name of fs.readdirSync(catalogDir)) {
    const dir = path.join(catalogDir, name);
    if (!fs.statSync(dir).isDirectory() || built.has(name)) continue;
    const generated = path.join(dir, 'index.html');
    if (fs.existsSync(generated) && fs.readFileSync(generated, 'utf8').includes('/catalog/#')) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`  removed stale /catalog/${name}/`);
    }
  }

  patchCatalogPage(live);
  fs.writeFileSync(path.join(DOCS, 'sitemap.xml'), sitemap(urls));

  console.log(`sitemap.xml: ${urls.length} URLs (${STATIC_ROUTES.length} static, ${indexed} catalog items)`);
  console.log(`catalog pages: ${built.size} built, ${built.size - indexed} noindex (outside their active window)`);
}

main();
