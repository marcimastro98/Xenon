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
import { createRequire } from 'node:module';
import { BIT_PATHS, headerHtml, footerHtml } from './site-chrome.mjs';
import { LANG_PAGES, HOME_LANGS, langsOf, pathOf } from './lang-pages.mjs';
import { LIMITS } from './page-meta.mjs';
import { trialCovers } from './trial-covers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const SITE = 'https://xenon-app.com';
const SHOTS = 'https://assets.xenon-app.com/community/shots/';
const DISCORD = 'https://discord.gg/MBVrw9kZyg';
// Five USD a month is sold on the membership page, not on the one-off coffee page.
const SUPPORT = 'https://www.buymeacoffee.com/marcimastro98/membership';
const TRIAL = 'https://xenon-supporter-hub.xenonedge.workers.dev/trial';
// Catalog entries come from the supporter hub, so their links and colours are
// checked here as the app checks them (server/community-catalog.js): a
// "reserve" link must be https on Discord, a preview colour a hex value. An
// esc()'d javascript: URL would still run, and a raw style value could load
// an outside url().
const RESERVE_HOSTS = new Set(['discord.gg', 'discord.com', 'www.discord.com']);
function safeReserve(u) {
  try {
    const x = new URL(String(u || ''));
    return x.protocol === 'https:' && RESERVE_HOSTS.has(x.hostname) ? x.href : DISCORD;
  } catch { return DISCORD; }
}
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

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
// An optional line left out of a template stays behind as spaces; a page keeps no trailing ones.
const noBlankIndent = (html) => html.replace(/^[ \t]+$/gm, '');

// Store descriptions are a small Markdown subset; the shared parser in
// @xenon/core decides their shape here too, so a page reads like the Store.
const richText = createRequire(import.meta.url)('../packages/core/src/rich-text.js');
const plainDesc = (s) => richText.plain(s);
const inlineHtml = (nodes) => nodes.map((n) => {
  if (n.t === 'text') return esc(n.v);
  if (n.t === 'code') return `<code>${esc(n.v)}</code>`;
  const tag = n.t === 'b' ? 'strong' : 'em';
  return `<${tag}>${inlineHtml(n.c)}</${tag}>`;
}).join('');
// Every piece of text goes through esc(); only the parser's own elements are written.
function descHtml(text) {
  return richText.parse(text).map((blk) => {
    if (blk.type === 'p') return `<p>${blk.lines.map(inlineHtml).join('<br>')}</p>`;
    if (blk.type === 'h') return `<p><strong>${inlineHtml(blk.c)}</strong></p>`;
    return `<${blk.type}>${blk.items.map((it) => `<li>${inlineHtml(it)}</li>`).join('')}</${blk.type}>`;
  }).join('');
}

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

const SHEET_BAR = { violet: '#B4A0FF', yellow: '#FFD75E' };
const BIT = `<svg class="pg-bit" viewBox="0 0 8 11" shape-rendering="crispEdges" aria-hidden="true">${BIT_PATHS}</svg>`;

// A widget, Deck profile or package is software; a theme, background or ambient
// scene is not. Claiming SoftwareApplication for a colour palette would be a
// structured-data mismatch, and mismatches are what get a site's rich results
// pulled — so the type follows what the thing actually is.
const SOFTWARE_KINDS = new Set(['widget', 'deck', 'bundle']);

// One sentence per kind, saying what installing it actually changes in Xenon.
// Pages of the same kind share theirs, which is fine: it is the
// paragraph that lets a page answer "what is a Xenon ambient scene" at all,
// and the name, description, palette, tags and related list around it are what
// keep the page distinct from its siblings.
const KIND_BLURB = {
  theme: 'A theme repaints all of Xenon: accent, background, surfaces and text, ' +
    'on every screen Xenon is open on. It changes nothing about which widgets you run.',
  bg: 'A background replaces Xenon\'s backdrop with an animated scene that draws behind ' +
    'your widgets. It runs locally on your own machine, with no video file to download.',
  page: 'A page is a ready-made layout: which widgets sit where, at what size, ' +
    'across the grid. Importing it adds the page alongside the ones you already have.',
  deck: 'A Deck profile is a set of touch keys for apps, files, sites, media controls and macros, ' +
    'laid out ready to press. You can edit every key after importing it.',
  widget: 'A widget is a tile you place where you want it in Xenon. It runs sandboxed, with no ' +
    'network access unless its manifest asks for named hosts and you approve them at install.',
  bundle: 'A package installs several pieces at once, usually a theme, a background and one ' +
    'or more widgets built to look like each other, so the whole look changes in one paste.',
  ambient: 'An ambient scene takes over the full screen when Xenon goes idle, and steps ' +
    'aside the moment you touch it. It works like a screensaver.',
  icons: 'An icon pack replaces the artwork on your Deck keys, so a profile can look like one ' +
    'thing rather than a grid of defaults.',
  sounds: 'A sound pack replaces Xenon\'s own feedback sounds: key presses, alerts ' +
    'and the voice session chimes.',
};

/* ── the per-entry page ──────────────────────────────────────────────────── */

// Entry and creator pages open on a sheet like every other page: /site.css draws
// the sheet and /guide.css the text, both linked before this block, so it holds
// only what these pages alone have. Do not add a colour here that site.css does
// not have: this template writes more pages than any other on the site.
// Under this a description reads as a fragment in a result: tools/site-review/seo.mjs
// warns at the same figure.
const MIN_SNIPPET = 70;

const PAGE_CSS = `
.pg h1{overflow-wrap:anywhere}
.pg-pic.ent-pic{min-height:calc(min(100vw,1440px)/5)}
.pg-pic.ent-pic img{width:auto;max-width:100%;max-height:min(66vh,560px);margin-inline:0}
.ent{display:grid;grid-template-columns:minmax(0,var(--maxw)) minmax(0,340px);column-gap:clamp(48px,7vw,112px);justify-content:space-between;align-items:start}
.ent-main>:first-child,.ent-main>section:first-child h2{margin-top:0}
.ent-side{position:sticky;top:calc(96px + var(--strip-h,0px))}
.ent-side h2{margin:0 0 6px;font-size:24px}
.desc p,.desc ul,.desc ol{margin:0 0 .7em}
.desc>:last-child{margin-bottom:0}
.shots{display:grid;gap:16px;margin-top:32px}
.shots img{display:block;width:100%;height:auto;border-radius:var(--r-2)}
.sw{display:flex;flex-wrap:wrap;gap:14px}
.sw span{display:flex;align-items:center;gap:8px;font-size:16px;color:var(--muted);font-variant-numeric:tabular-nums}
.sw i{display:block;width:16px;height:16px;border-radius:4px;box-shadow:inset 0 0 0 1px var(--line)}
.facts{list-style:none;margin:0;padding:0}
.facts li{display:grid;grid-template-columns:88px minmax(0,1fr);gap:12px;margin:0;padding:10px 0;border-bottom:1px solid var(--line);font-size:16px;line-height:1.45}
.facts li:last-child{border-bottom:0}
.facts a,.ent-more .note a{display:inline-flex;align-items:center;min-height:24px}
@media(pointer:coarse){.facts a,.ent-more .note a{min-height:44px}}
.ent-more h2{margin-top:0}
.cr-sum{display:flex;flex-wrap:wrap;gap:16px 40px;margin-top:24px;font-size:16px;line-height:1.35}
.cr-sum div{max-width:27ch}
.cr-sum b{display:block;font:800 clamp(34px,3vw,44px)/1.1 var(--display);font-variant-numeric:tabular-nums}
.cr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr));gap:32px 20px}
.cr-card{display:flex;flex-direction:column;gap:4px;color:inherit;text-decoration:none}
.cr-shot{display:block;aspect-ratio:16/9;margin-bottom:8px;border-radius:var(--r-2);overflow:hidden;background:var(--g-1)}
.cr-shot img{display:block;width:100%;height:100%;object-fit:cover}
.cr-n{font:700 20px/1.25 var(--display)}
.cr-card:hover .cr-n{text-decoration:underline;text-underline-offset:.18em}
.cr-k,.cr-d,.cr-live{font-size:16px;line-height:1.4;color:var(--muted)}
.cr-live{display:flex;gap:12px;min-height:1.4em;font-variant-numeric:tabular-nums}
@media(max-width:1000px){.ent{grid-template-columns:minmax(0,1fr)}.ent-side{position:static;margin-top:48px}}
`.trim();

// One item as a card, on a creator's page and under an entry. The box keeps its 16/9
// whether or not the picture lands, so a missing screenshot leaves a tinted rectangle
// instead of collapsing the card and reflowing the grid under the reader's cursor.
function itemCard(e, { eager = false, full = false } = {}) {
  const locked = e.locked === true || e.supportersOnly === true;
  const kind = (KIND_LABEL[e.kind] || e.kind) + (locked ? ' for supporters' : '');
  const desc = full && e.description ? clamp(plainDesc(e.description), 140) : '';
  const thumb = Number.isInteger(e.shots) && e.shots > 0
    ? `<img src="${esc(shotUrl(e.id, 1))}" alt="${esc(e.name)} running in Xenon"` +
      ` loading="${eager ? 'eager' : 'lazy'}" decoding="async"` +
      ` onerror="this.onerror=function(){this.style.display='none'};this.src='${esc(shotUrl(e.id, 1, 'png'))}'">`
    : '';
  return `      <a class="cr-card" href="/catalog/${encodeURIComponent(e.id)}/">
        <span class="cr-shot">${thumb}</span>
        <span class="cr-n">${esc(e.name)}</span>
        <span class="cr-k">${esc(kind)}</span>
        ${desc ? `<span class="cr-d">${esc(desc)}</span>` : ''}
        ${full ? `<span class="cr-live"><span data-iid="${esc(e.id)}"></span><span data-rid="${esc(e.id)}"></span></span>` : ''}
      </a>`;
}

// Every entry page used to link only to /, /catalog/ and the two evergreen
// pages, which made the catalog a star: one hub and 45 leaves with nothing
// between them. A crawler reads that shape as 45 pages nobody links to, and
// Search Console said so — "discovered, currently not indexed" on all of them.
// These links are the lateral edges. Related is scored, never random: CI
// regenerates every page on each deploy, so a shuffled list would rewrite 45
// files on every run and bury a real catalog change in the noise.
//
// Only LIVE entries are eligible. A page outside its active window ships
// noindex, and pointing a crawler at noindexed pages wastes the very budget
// this block exists to attract.
function relatedFor(e, live) {
  const mine = new Set((e.tags || []).map((t) => String(t).toLowerCase()));
  const scored = [];
  for (const o of live) {
    if (o.id === e.id || !(o.shots > 0)) continue;
    const theirs = (o.tags || []).map((t) => String(t).toLowerCase());
    // A shared tag is the strongest signal the catalog carries: it is the only
    // field an author writes about what the thing IS rather than what it is.
    let score = theirs.filter((t) => mine.has(t)).length * 3;
    if (o.category && o.category === e.category) score += 2;
    if (o.author === e.author) score += 2;
    if (o.kind === e.kind) score += 1;
    if (score > 0) scored.push({ o, score });
  }
  // id breaks ties, so the same catalog always produces byte-identical pages.
  scored.sort((a, b) => b.score - a.score || (a.o.id < b.o.id ? -1 : 1));
  const out = scored.slice(0, 6).map((x) => x.o);
  // A brand-new entry with unusual tags can score zero against everything. It
  // still deserves a way out of the page, so the newest items fill the gap.
  if (out.length < 4) {
    const have = new Set([e.id, ...out.map((o) => o.id)]);
    const rest = live
      .filter((o) => !have.has(o.id) && o.shots > 0)
      .sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')) ||
        (a.id < b.id ? -1 : 1));
    out.push(...rest.slice(0, 4 - out.length));
  }
  return out;
}

function entryPage(e, indexable, live = []) {
  const url = `${SITE}/catalog/${encodeURIComponent(e.id)}/`;
  const kindLabel = KIND_LABEL[e.kind] || e.kind;
  const catLabel = e.category ? (CAT_LABEL[e.category] || e.category) : '';
  const locked = e.locked === true || e.supportersOnly === true;
  const limited = e.limited && typeof e.limited === 'object' ? e.limited : null;
  const soldOut = limited ? Number(limited.claimed) >= Number(limited.total) : false;
  const shots = Number.isInteger(e.shots) ? Math.max(0, Math.min(8, e.shots)) : 0;
  const published = isoDay(e.addedAt);
  const modified = isoDay(e.updatedAt) || published;

  const title = `${e.name}: ${kindLabel} for Xenon`;
  // A creator's line can be a few words: too short to stand as a result's snippet,
  // so it leads and the plain facts follow it.
  const own = plainDesc(e.description);
  const about = `a ${kindLabel.toLowerCase()} for Xenon by ${e.author}`;
  const description = clamp(
    !own ? `${e.name}, ${about}. Import it into your local Xenon in one paste.`
      : own.length < MIN_SNIPPET ? `${own.replace(/\.$/, '')}. ${e.name}, ${about}.`
        : own
  );
  const image = shots > 0 ? shotUrl(e.id, 1) : `${SITE}/images/home/og-card.png`;

  /* ── structured data ── */
  const graph = [];
  const work = {
    '@type': SOFTWARE_KINDS.has(e.kind) ? 'SoftwareApplication' : 'CreativeWork',
    '@id': url + '#item',
    name: e.name,
    url,
    description: (plainDesc(e.description) || description).replace(/\s+/g, ' ').trim(),
    inLanguage: 'en',
    author: { '@type': 'Person', name: e.author },
    isPartOf: { '@id': `${SITE}/catalog/#catalog` },
    image,
  };
  if (SOFTWARE_KINDS.has(e.kind)) {
    work.applicationCategory = 'UtilitiesApplication';
    // Xenon has run on all three since v4.11.0. This said "Windows 10, Windows 11"
    // and was telling Google the opposite on 23 pages.
    work.operatingSystem = 'Windows, macOS, Linux';
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
      `<img src="${esc(shotUrl(e.id, i))}" alt="${esc(e.name)}, screenshot ${i} of ${shots}"` +
      ` loading="${i === 1 ? 'eager' : 'lazy'}"${i === 1 ? ' fetchpriority="high"' : ''} decoding="async"` +
      ` onerror="this.onerror=function(){this.remove()};this.src='${esc(shotUrl(e.id, i, 'png'))}'">`
    );
  }

  const [firstShot, ...moreShots] = shotTags;

  const swatches = e.preview
    ? ['accent', 'bg', 'text']
        .filter((k) => e.preview[k])
        .filter((k) => HEX_COLOR.test(String(e.preview[k])))
        .map((k) => `<span><i style="background:${esc(e.preview[k])}"></i>${esc(e.preview[k])}</span>`)
        .join('')
    : '';

  const what = limited ? `Limited edition ${kindLabel.toLowerCase()} for Xenon`
    : locked ? `${kindLabel} for Xenon supporters`
    : `${kindLabel} for Xenon`;
  const sheet = limited || locked ? 'yellow' : 'violet';

  // Internal links stay root-relative so the page is correct on the production
  // domain, on the github.io mirror and in a local preview alike.
  const inCatalog = `/catalog/#${encodeURIComponent(e.id)}`;
  let buttons, note;
  if (limited && soldOut) {
    buttons = `<a class="pg-alt" href="${inCatalog}">See it in the catalog</a>`;
    note = `Sold out: all ${esc(limited.total)} copies of this drop are claimed.`;
  } else if (limited) {
    buttons =
      `<a class="pg-key" href="${esc(safeReserve(limited.reserveUrl))}" rel="noopener">Reserve on Discord</a>` +
      `<a class="pg-alt" href="${inCatalog}">Open in the catalog</a>`;
    note = `A limited drop: ${esc(limited.total)} copies, ` +
      `${Math.max(0, Number(limited.total) - Number(limited.claimed))} left. ` +
      `Discord verifies your account and sends a personal access code.`;
  } else if (locked) {
    buttons =
      `<a class="pg-key" href="${SUPPORT}" target="_blank" rel="noopener" data-track="coffee_click" data-track-location="catalog_item">Become a supporter</a>` +
      `<a class="pg-alt" href="${inCatalog}">I have a code</a>`;
    note = `Included for supporters, 5 USD a month. Unlock it in the catalog with your code, ` +
      `then paste it into Xenon under Settings → Widgets &amp; sharing → Import.`;
    if (trialCovers(e, Date.now())) {
      note += ` Or <a href="${TRIAL}" target="_blank" rel="noopener" data-track="trial_click" data-track-location="catalog_item">try it free for 7 days</a>, once per PC, with no card.`;
    }
  } else {
    buttons =
      `<a class="pg-key" href="${inCatalog}">Copy the code in the catalog</a>` +
      `<a class="pg-alt" href="/">Get Xenon</a>`;
    note = `Free. Copy the share code, then paste it into Xenon under ` +
      `Settings → Widgets &amp; sharing → Import. Everything stays on your machine.`;
  }

  // The steps a visitor actually has to perform, written out instead of implied
  // by a button. Import is the same three moves for everything in the catalog;
  // what changes is how you come by the code, which is exactly the part a
  // supporters' item or a limited drop needs explained on its own page.
  const steps = [];
  if (limited && soldOut) {
    steps.push(
      `This drop is closed: all ${esc(limited.total)} copies were claimed.`,
      `<a href="/catalog/">Browse the rest of the catalog</a> for something still available.`
    );
  } else {
    if (limited) {
      steps.push(`<a href="${esc(safeReserve(limited.reserveUrl))}" rel="noopener">Reserve a copy on Discord</a>. ` +
        `Discord verifies your account and sends you a personal access code.`);
    } else if (locked) {
      steps.push(`<a href="${SUPPORT}" target="_blank" rel="noopener">Become a supporter</a>, 5 USD a month, ` +
        `and you get a personal code.`);
      steps.push(`<a href="${inCatalog}">Open ${esc(e.name)} in the catalog</a> and unlock it with your ` +
        `code. One code unlocks it on up to three machines.`);
    } else {
      steps.push(`<a href="${inCatalog}">Open ${esc(e.name)} in the catalog</a> and press Copy code.`);
    }
    steps.push(`In Xenon, open <b>Settings → Widgets &amp; sharing → Import</b> and paste the code.`);
    steps.push(`Xenon shows you what the code contains before anything is applied. Confirm, and ` +
      `${esc(e.name)} is in Xenon.`);
    steps.push(e.appVersionMin
      ? `This one needs <a href="/">Xenon ${esc(e.appVersionMin)} or later</a>. An older install ` +
        `refuses the code rather than importing half of it.`
      : `Do not have Xenon yet? <a href="/">It is free</a>, with its source on GitHub, for Windows, with macOS and Linux in beta.`);
  }

  // A plain facts table. Every row is a field the catalog already carries, and
  // together they are what someone comparing two items wants without opening
  // the interactive catalog and clicking through.
  const facts = [['Type', esc(kindLabel)]];
  if (catLabel) facts.push(['Category', esc(catLabel)]);
  facts.push(['Made by', `<a href="/creators/${creatorSlug(e.author)}/">${esc(authorName(e.author))}</a>` + (isSupporter(e) ? ' (supporter)' : '')]);
  if (e.version) facts.push(['Version', 'v' + esc(e.version)]);
  facts.push(['Needs', e.appVersionMin ? `Xenon ${esc(e.appVersionMin)} or later` : 'Any recent Xenon']);
  facts.push(['Runs on', 'Windows, with macOS and Linux in beta, on any screen: a monitor, a Xeneon Edge, ' +
    'a tablet or a paired phone']);
  facts.push(['Price', limited ? 'Reserved on Discord' : locked ? 'Included for supporters, 5 USD a month' : 'Free']);
  if (published) facts.push(['Added', esc(published)]);
  if (modified && modified !== published) facts.push(['Updated', esc(modified)]);
  if (Array.isArray(e.tags) && e.tags.length) facts.push(['Tags', e.tags.map((t) => '#' + esc(t)).join(' ')]);

  const related = relatedFor(e, live);
  const relatedBlock = related.length
    ? `<section class="pg-body ent-more" aria-labelledby="more-h">
  <h2 id="more-h">More from the catalog</h2>
  <div class="cr-grid">
${related.map((o) => itemCard(o)).join('\n')}
  </div>
  <p class="note"><a href="/catalog/">See all community items</a></p>
</section>`
    : '';

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
<meta name="theme-color" content="${SHEET_BAR[sheet]}">
<link rel="icon" type="image/png" href="/images/favicon.png">

<!-- Theme, before the first paint: a deferred script would flash the other
     ground first. /theme.js only builds the control. -->
<script>try{var d=document.documentElement,m=localStorage.getItem('xenon.site.theme');if(m==='light'||m==='dark')d.setAttribute('data-theme',m);if(Number(localStorage.getItem('xenon.site.strip.until'))>Date.now()){d.setAttribute('data-strip','');addEventListener('load',function(){d.removeAttribute('data-strip')})}}catch(e){}</script>
<script src="/theme.js" defer></script>
<script src="/chrome.js" defer></script>

<meta property="og:type" content="${SOFTWARE_KINDS.has(e.kind) ? 'product' : 'article'}">
<meta property="og:site_name" content="Xenon">
<meta property="og:locale" content="en_US">
<meta property="og:url" content="${esc(url)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:alt" content="${esc(e.name)} running in Xenon">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">

<link rel="preconnect" href="https://assets.xenon-app.com" crossorigin>
<link rel="stylesheet" href="/site.css">
<link rel="stylesheet" href="/guide.css">
<style>${PAGE_CSS}</style>
<script type="application/ld+json">
${ld({ '@context': 'https://schema.org', '@graph': graph })}
</script>
</head>
<body data-sheet="${sheet}">

${headerHtml()}

<main>
<section class="pg" aria-labelledby="pg-h">
  <div class="pg-w${firstShot ? ' wide' : ''}">
    <div class="pg-copy">
      <nav class="xc" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/catalog/">Catalog</a></li><li><a href="/catalog/${encodeURIComponent(e.id)}/" aria-current="page">${esc(e.name)}</a></li></ol></nav>
      <h1 id="pg-h">${esc(e.name)}</h1>
      <p class="lede">${esc(what)}, by <a href="/creators/${creatorSlug(e.author)}/">${esc(authorName(e.author))}</a></p>
      <div class="pg-act">${buttons}</div>
      <p class="updated">${note}</p>
    </div>
    ${firstShot ? `<figure class="pg-pic ent-pic">${firstShot}</figure>` : BIT}
  </div>
</section>

<div class="pg-body ent">
  <div class="ent-main">
    ${e.description ? `<div class="desc">${descHtml(e.description)}</div>` : ''}
    ${e.perfWarning
      ? `<p class="note">This one asks a little more of the machine than most, which is worth knowing before you load it onto a small screen.</p>`
      : ''}
    ${moreShots.length ? `<div class="shots">${moreShots.join('')}</div>` : ''}
    ${e.changelog ? `<section><h2>What's in it</h2><p>${esc(e.changelog)}</p></section>` : ''}
    ${KIND_BLURB[e.kind]
      ? `<section><h2>What a ${esc(kindLabel.toLowerCase())} does</h2><p>${KIND_BLURB[e.kind]}</p></section>`
      : ''}
    ${swatches ? `<section><h2>Palette</h2><div class="sw">${swatches}</div></section>` : ''}
    ${steps.length
      ? `<section><h2>How to install it</h2><ol>` +
        steps.map((s) => `<li>${s}</li>`).join('') + `</ol></section>`
      : ''}
  </div>
  <aside class="ent-side" aria-labelledby="ent-facts">
    <h2 id="ent-facts">At a glance</h2>
    <ul class="facts">
${facts.map(([k, v]) => `      <li><b>${k}</b><span>${v}</span></li>`).join('\n')}
    </ul>
  </aside>
</div>
${relatedBlock}
</main>

${footerHtml()}

</body>
</html>
`;
}

/* ── one page per creator ─────────────────────────────────────────────────── */

// A creator's own page: everything they published, with the live install and
// rating figures the hub already serves. It exists so that a person who made
// something has a page that is theirs to link — "your theme was installed 43
// times" is the reason a creator shares, and every share is a door into Xenon
// that the author of Xenon did not have to open. The catalog and every entry
// page link here; this is what turns up when someone searches a creator's name
// next to Xenon.
const HUB = 'https://xenon-supporter-hub.xenonedge.workers.dev';

function creatorSlug(author) {
  return String(author || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

// The project signs its own packs in two spellings, and does not support itself.
const OWN_SLUG = 'xenon';
const authorName = (author) => (creatorSlug(author) === OWN_SLUG ? 'Xenon' : author);
const isSupporter = (e) => e.authorSupporter === true && creatorSlug(e.author) !== OWN_SLUG;

// Group live entries by creator. Author strings vary in case ("xenon" and
// "Xenon" are one person); the slug decides identity and the most-used spelling
// is the one shown.
function creators(live) {
  const groups = new Map();
  for (const e of live) {
    const slug = creatorSlug(e.author);
    if (!slug) continue;
    const g = groups.get(slug) || { slug, names: new Map(), entries: [] };
    g.names.set(e.author, (g.names.get(e.author) || 0) + 1);
    g.entries.push(e);
    groups.set(slug, g);
  }
  return [...groups.values()].map((g) => ({
    slug: g.slug,
    name: authorName([...g.names.entries()].sort((a, b) => b[1] - a[1])[0][0]),
    supporter: g.entries.some(isSupporter),
    entries: g.entries,
  })).sort((a, b) => b.entries.length - a.entries.length || a.name.localeCompare(b.name));
}

function creatorPage(c) {
  const url = `${SITE}/creators/${c.slug}/`;
  const n = c.entries.length;
  const kinds = [...new Set(c.entries.map((e) => KIND_LABEL[e.kind] || e.kind))];
  const count = `${n} ${n === 1 ? 'creation' : 'creations'}`;
  const fullTitle = `${c.name} on Xenon: ${count} you can install`;
  const title = fullTitle.length > LIMITS.title ? `${c.name} on Xenon: ${count}` : fullTitle;
  const description = clamp(
    `${n === 1 ? 'One creation' : n + ' creations'} by ${c.name} for Xenon: ` +
    kinds.map((k) => k.toLowerCase()).join(', ') + '. Install any of them into your own Xenon in one paste.'
  );
  const image = (() => {
    const withShot = c.entries.find((e) => Number.isInteger(e.shots) && e.shots > 0);
    return withShot ? shotUrl(withShot.id, 1) : `${SITE}/images/home/og-card.png`;
  })();
  const ids = c.entries.map((e) => e.id);

  const graph = [
    {
      '@type': 'ProfilePage',
      '@id': url + '#page',
      url,
      name: title,
      description,
      inLanguage: 'en',
      isPartOf: { '@id': `${SITE}/#website` },
      mainEntity: { '@id': url + '#person' },
    },
    { '@type': 'Person', '@id': url + '#person', name: c.name, url },
    {
      '@type': 'ItemList',
      '@id': url + '#items',
      name: `Creations by ${c.name}`,
      numberOfItems: n,
      itemListOrder: 'https://schema.org/ItemListUnordered',
      itemListElement: c.entries.map((e, i) => ({
        '@type': 'ListItem', position: i + 1, name: e.name,
        url: `${SITE}/catalog/${encodeURIComponent(e.id)}/`,
      })),
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Xenon', item: SITE + '/' },
        { '@type': 'ListItem', position: 2, name: 'Community catalog', item: SITE + '/catalog/' },
        { '@type': 'ListItem', position: 3, name: c.name, item: url },
      ],
    },
  ];

  // Pictures first, so an entry without one never opens a row. The first two load eagerly
  // because they are above the fold on a phone; the rest wait.
  const cards = [...c.entries].sort((a, b) => (b.shots > 0) - (a.shots > 0))
    .map((e, i) => itemCard(e, { eager: i < 2, full: true })).join('\n');

  return `<!DOCTYPE html>
<!-- generated: creator page (tools/build-seo.mjs) — do not edit by hand -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
<meta name="theme-color" content="${SHEET_BAR.violet}">
<link rel="icon" type="image/png" href="/images/favicon.png">
<script>try{var d=document.documentElement,m=localStorage.getItem('xenon.site.theme');if(m==='light'||m==='dark')d.setAttribute('data-theme',m);if(Number(localStorage.getItem('xenon.site.strip.until'))>Date.now()){d.setAttribute('data-strip','');addEventListener('load',function(){d.removeAttribute('data-strip')})}}catch(e){}</script>
<script src="/theme.js" defer></script>
<script src="/chrome.js" defer></script>
<meta property="og:type" content="profile">
<meta property="og:site_name" content="Xenon">
<meta property="og:locale" content="en_US">
<meta property="og:url" content="${esc(url)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(image)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
<link rel="preconnect" href="https://assets.xenon-app.com" crossorigin>
<link rel="stylesheet" href="/site.css">
<link rel="stylesheet" href="/guide.css">
<style>${PAGE_CSS}</style>
<script type="application/ld+json">
${ld({ '@context': 'https://schema.org', '@graph': graph })}
</script>
</head>
<body data-sheet="violet">

${headerHtml()}

<main>
<section class="pg" aria-labelledby="pg-h">
  <div class="pg-w">
    <div class="pg-copy">
      <nav class="xc" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/catalog/">Catalog</a></li><li><a href="/creators/${c.slug}/" aria-current="page">${esc(c.name)}</a></li></ol></nav>
      <h1 id="pg-h">${esc(c.name)}</h1>
      <p class="lede">${n === 1 ? 'One creation' : n + ' creations'} for Xenon: ${esc(kinds.join(', ').toLowerCase())}.${c.supporter ? ` ${esc(c.name)} supports Xenon.` : ''}</p>
      <div class="cr-sum">
        <div><b id="cr-installs">…</b>installs, reported by the people who chose to count</div>
        <div><b id="cr-rating">…</b>average rating</div>
        <div><b>${n}</b>in the catalog</div>
      </div>
    </div>
    ${BIT}
  </div>
</section>

<div class="pg-body">
  <div class="cr-grid">
${cards}
  </div>
  <div class="wrap">
    <div class="card">
      <h2>Made these?</h2>
      <p>This page is yours to link. It is what people find when they search your name next to Xenon, and the numbers on it are live.</p>
      <p>To publish something new, <a href="/submit/">the submission form</a> takes a share code and two or three screenshots.</p>
    </div>
    <p class="note"><a href="/catalog/">See everything in the catalog</a></p>
  </div>
</div>
</main>

${footerHtml()}

<script>
(function () {
  // Live figures from the hub, the same two public endpoints the catalog reads.
  // Counts are installs REPORTED by people who left the anonymous counter on,
  // never unique owners; ratings are shown only past the hub's minimum.
  var IDS = ${JSON.stringify(ids)};
  var HUB = ${JSON.stringify(HUB)};
  var q = encodeURIComponent(IDS.join(','));
  function txt(id, s) { var el = document.getElementById(id); if (el) el.textContent = s; }
  fetch(HUB + '/catalog/installs?ids=' + q).then(function (r) { return r.json(); }).then(function (d) {
    var counts = (d && d.counts) || {}; var total = 0;
    IDS.forEach(function (id) {
      var n = Number(counts[id]) || 0; total += n;
      var el = document.querySelector('[data-iid="' + id + '"]');
      // Same floor the catalog grid uses (10): under it a per-item count is
      // noise rather than a signal. The total above is exact, because a sum
      // over a whole body of work is not the same kind of number.
      if (el && n >= 10) el.textContent = n + ' installs';
    });
    txt('cr-installs', String(total));
  }).catch(function () { txt('cr-installs', '–'); });
  fetch(HUB + '/ratings?ids=' + q).then(function (r) { return r.json(); }).then(function (d) {
    var ratings = (d && d.ratings) || {}; var min = Number(d && d.minDisplayCount) || 3;
    var sum = 0, votes = 0;
    IDS.forEach(function (id) {
      var r = ratings[id]; if (!r || !(r.count >= min)) return;
      sum += Number(r.avg) * Number(r.count); votes += Number(r.count);
      var el = document.querySelector('[data-rid="' + id + '"]');
      if (el) el.textContent = '★ ' + Number(r.avg).toFixed(1) + ' (' + r.count + ')';
    });
    txt('cr-rating', votes ? (sum / votes).toFixed(1) + ' ★' : '–');
  }).catch(function () { txt('cr-rating', '–'); });
})();
</script>
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
        description: 'Themes, animated backgrounds, pages, Deck profiles, widgets, ' +
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
  // One indexable copy of the home page per language, generated from the
  // English one by tools/build-i18n.mjs. Spanish is the first language among
  // the app's users and had no findable page at all until these existed.
  { loc: '/es/', file: 'docs/es/index.html', priority: '0.9', changefreq: 'weekly' },
  { loc: '/it/', file: 'docs/it/index.html', priority: '0.9', changefreq: 'weekly' },
  { loc: '/fr/', file: 'docs/fr/index.html', priority: '0.9', changefreq: 'weekly' },
  { loc: '/ko/', file: 'docs/ko/index.html', priority: '0.8', changefreq: 'weekly' },
  { loc: '/ja/', file: 'docs/ja/index.html', priority: '0.8', changefreq: 'weekly' },
  { loc: '/zh/', file: 'docs/zh/index.html', priority: '0.8', changefreq: 'weekly' },
  { loc: '/catalog/', file: 'docs/community/catalog.json', priority: '0.9', changefreq: 'daily' },
  { loc: '/create/', file: 'docs/create/index.html', priority: '0.8', changefreq: 'monthly' },
  // These three carry `robots: index, follow` and a canonical of their own, so
  // they were always meant to be found — they were simply never listed here,
  // which left the two pages that answer real search queries ("is Xenon a
  // virus", "use a phone as a second screen") out of the only file that tells
  // Google they exist.
  { loc: '/faq.html', file: 'docs/faq.html', priority: '0.7', changefreq: 'monthly' },
  { loc: '/phone.html', file: 'docs/phone.html', priority: '0.7', changefreq: 'monthly' },
  // The two pages written for the queries people actually arrive with: Google
  // is the site's first referrer and sends most of them to GitHub, because the
  // home page does not carry those words. These do.
  { loc: '/xeneon-edge-widgets.html', file: 'docs/xeneon-edge-widgets.html', priority: '0.8', changefreq: 'monthly' },
  { loc: '/tablet-dashboard.html', file: 'docs/tablet-dashboard.html', priority: '0.8', changefreq: 'monthly' },
  // Search Console says "xenon.exe" draws 131 impressions and almost no clicks:
  // people who found an unfamiliar process and want a straight answer, which the
  // home page is the wrong shape to give them.
  { loc: '/xenon-exe.html', file: 'docs/xenon-exe.html', priority: '0.7', changefreq: 'monthly' },
  // "xenon download" and "xenon linux": 74 impressions in Search Console and
  // no clicks, because the home page's title carried neither word.
  { loc: '/download.html', file: 'docs/download.html', priority: '0.9', changefreq: 'weekly' },
  { loc: '/linux.html', file: 'docs/linux.html', priority: '0.7', changefreq: 'monthly' },
  { loc: '/demo/', file: 'docs/demo/index.html', priority: '0.7', changefreq: 'monthly' },
  { loc: '/submit/', file: 'docs/submit/index.html', priority: '0.5', changefreq: 'monthly' },
  { loc: '/privacy.html', file: 'docs/privacy.html', priority: '0.3', changefreq: 'yearly' },
  // Generated from CHANGELOG.md on every deploy (tools/build-releases.mjs): the
  // answer to "is it maintained?", dated, on the site instead of on GitHub.
  { loc: '/releases.html', file: 'CHANGELOG.md', priority: '0.5', changefreq: 'weekly' },
  // The pages for what people search for beyond "Xenon": a Mac, the widget
  // list, Deck keys, Claude Code on a second screen, a sensor panel.
  { loc: '/mac.html', file: 'docs/mac.html', priority: '0.8', changefreq: 'monthly' },
  { loc: '/widgets.html', file: 'docs/widgets.html', priority: '0.8', changefreq: 'monthly' },
  { loc: '/deck.html', file: 'docs/deck.html', priority: '0.7', changefreq: 'monthly' },
  { loc: '/claude-code.html', file: 'docs/claude-code.html', priority: '0.7', changefreq: 'monthly' },
  { loc: '/codex.html', file: 'docs/codex.html', priority: '0.7', changefreq: 'monthly' },
  { loc: '/sensor-panel.html', file: 'docs/sensor-panel.html', priority: '0.7', changefreq: 'monthly' },
  // Xenon without a second monitor: widgets on the desktop, the game overlay, capture.
  { loc: '/single-screen.html', file: 'docs/single-screen.html', priority: '0.8', changefreq: 'monthly' },
  { loc: '/fps-overlay.html', file: 'docs/fps-overlay.html', priority: '0.8', changefreq: 'monthly' },
  { loc: '/screen-recorder.html', file: 'docs/screen-recorder.html', priority: '0.8', changefreq: 'monthly' },
];

// Every page published in several languages lists all of them, each URL
// naming its siblings (hreflang in the sitemap as well as in the page).
function alternatesOf(page) {
  const langs = langsOf(page);
  if (langs.length < 2) return null;
  return langs.map((l) => ({ lang: l, href: SITE + pathOf(page, l) }))
    .concat([{ lang: 'x-default', href: SITE + pathOf(page, 'en') }]);
}

function languageRoutes() {
  const out = [];
  for (const p of LANG_PAGES) {
    for (const l of langsOf(p.page)) {
      if (l === 'en') continue;
      out.push({ loc: pathOf(p.page, l), file: 'docs/' + l + '/' + p.page, priority: '0.6', changefreq: 'monthly', page: p.page });
    }
  }
  return out;
}

function sitemap(urls) {
  const body = urls.map((u) => {
    const lines = [`    <loc>${esc(SITE + u.loc)}</loc>`];
    for (const a of (u.alternates || [])) lines.push(`    <xhtml:link rel="alternate" hreflang="${a.lang}" href="${esc(a.href)}"/>`);
    if (u.lastmod) lines.push(`    <lastmod>${u.lastmod}</lastmod>`);
    if (u.changefreq) lines.push(`    <changefreq>${u.changefreq}</changefreq>`);
    if (u.priority) lines.push(`    <priority>${u.priority}</priority>`);
    return `  <url>\n${lines.join('\n')}\n  </url>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by tools/build-seo.mjs — do not edit by hand. -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml"
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

  const pageOf = (loc) => {
    const file = loc.replace(new RegExp(`^/(?:(?:${HOME_LANGS.join('|')})/)?`), '');
    return file === '' ? 'index.html' : file;
  };
  const urls = STATIC_ROUTES.concat(languageRoutes()).map((r) => ({
    loc: r.loc, lastmod: gitDate(r.file), changefreq: r.changefreq, priority: r.priority,
    alternates: alternatesOf(r.page || pageOf(r.loc)),
  }));

  const built = new Set();
  const live = [];
  const usable = [];
  let indexed = 0;

  // Two passes, because a page's Related block links to its neighbours and so
  // cannot be written until every neighbour is known to be live. The first pass
  // decides what exists; the second writes it.
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
    usable.push({ e, isLive });
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

  // Second pass: `live` is complete, so each page can link to its neighbours.
  for (const { e, isLive } of usable) {
    const dir = path.join(DOCS, 'catalog', e.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), noBlankIndent(entryPage(e, isLive, live)));
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

  // One page per creator, from the live entries only. Same sweep rule as the
  // catalog pages: a creator whose last entry left the catalog leaves no page.
  const creatorsDir = path.join(DOCS, 'creators');
  fs.mkdirSync(creatorsDir, { recursive: true });
  const made = creators(live);
  const keep = new Set();
  for (const c of made) {
    const dir = path.join(creatorsDir, c.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), noBlankIndent(creatorPage(c)));
    keep.add(c.slug);
    urls.push({ loc: `/creators/${c.slug}/`, lastmod: '', changefreq: 'monthly', priority: '0.5' });
  }
  for (const name of fs.readdirSync(creatorsDir)) {
    const dir = path.join(creatorsDir, name);
    if (!fs.statSync(dir).isDirectory() || keep.has(name)) continue;
    const generated = path.join(dir, 'index.html');
    if (fs.existsSync(generated) && fs.readFileSync(generated, 'utf8').includes('generated: creator page')) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`  removed stale /creators/${name}/`);
    }
  }

  patchCatalogPage(live);
  fs.writeFileSync(path.join(DOCS, 'sitemap.xml'), sitemap(urls));

  console.log(`sitemap.xml: ${urls.length} URLs (${STATIC_ROUTES.length} static, ${indexed} catalog items)`);
  console.log(`catalog pages: ${built.size} built, ${built.size - indexed} noindex (outside their active window)`);
  console.log(`creator pages: ${made.length}`);
}

main();
