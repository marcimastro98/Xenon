'use strict';
// Cleans the Store catalog the site publishes before the app trusts it: each entry's id, kind,
// version, pictures, price and limits, and which entries are showing.

const { DESCRIPTION_MAX } = require('./description-limit.js');

const MAX_ENTRIES = 200;

const CODE_INLINE_MAX = 8000;   // longer codes must ship as codes/<id>.txt

// Kinds the gallery may list — the import pipeline's PRESET_KINDS.
// Keep in step with PRESET_KINDS (js/preset-share.js), the hub admin's KINDS
// (xenon-supporter-hub src/catalog-admin.js), the issue-template dropdown and
// the website gallery's KINDS (docs/catalog/index.html). 'ambient-layout' is
// deliberately not catalog-listable.
const CATALOG_KINDS = new Set(['theme', 'page', 'deck', 'bundle', 'bg', 'widget', 'ambient', 'icons', 'sounds', 'topbar']);

// Entry/code ids become URL path segments (codes/<id>.txt) and DOM anchors —
// conservative charset, no traversal by construction.
const ENTRY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
// Catalog v2 (all optional, additive): version/pkgId power the update check for
// installed SDK packages; category/tags drive the gallery filters; publisher is
// a GitHub identity (handle charset-pinned; url accepted ONLY on github.com).
const VERSION_RE = /^[0-9]+(\.[0-9]+)*$/;
const PKG_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;      // mirrors the widget-package id charset
const TAG_RE = /^[a-z0-9-]{1,20}$/;
const HANDLE_RE = /^[A-Za-z0-9-]{1,40}$/;
const CATALOG_CATEGORIES = new Set(['deck', 'streaming', 'media', 'smart-home', 'system', 'style', 'fun', 'tools']);
// Visibility scheduling (all optional, additive): activeFrom/activeUntil bound a
// date window the entry is listed within. An ISO date or datetime; parsed with
// Date.parse at SERVE time so a drop appears/retires on time without a re-fetch.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
// How many screenshot/GIF sidecars a single entry may carry. Each is a fixed,
// id-derived image (WebP — animated allowed — with a PNG fallback) — see the
// screenshot note below.
const MAX_SHOTS = 6;
// The hub's ceiling on a Sparks price (buy.js MAX_PRICE): 1 Spark = 1 US cent.
const SPARKS_MAX = 100000;

function cleanStr(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Limited-edition metadata. Legacy entries use the catalog's claimed fallback
// and a Discord reserveUrl. Automatic entries add fulfillment:'hub' + dropId;
// the gallery then overlays live D1 stock through /api/community/limited-status.
// Claim URLs are always derived from the fixed Hub base, never accepted here.
function normalizeLimited(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const total = Number.isInteger(raw.total) ? Math.max(0, Math.min(99999, raw.total)) : 0;
  if (total <= 0) return null;
  const claimed = Number.isInteger(raw.claimed) ? Math.max(0, Math.min(total, raw.claimed)) : 0;
  const lim = { total, claimed, left: total - claimed, soldOut: claimed >= total };
  const dropId = cleanStr(raw.dropId, 61);
  if (raw.fulfillment === 'hub' && ENTRY_ID_RE.test(dropId)) {
    lim.fulfillment = 'hub';
    lim.dropId = dropId;
    lim.channels = raw.channels === 'both' ? 'both' : 'discord';
    lim.numbered = raw.numbered === true;
  }
  const url = cleanStr(raw.reserveUrl, 200);
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (u.protocol === 'https:' && (host === 'discord.gg' || host === 'discord.com' || host === 'www.discord.com')) {
      lim.reserveUrl = u.toString();
    }
  } catch { /* no/invalid url — client uses the default Discord invite */ }
  return lim;
}

// Rebuild one catalog entry into the exact shape the client trusts, or null.
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = cleanStr(raw.id, 61);
  if (!ENTRY_ID_RE.test(id)) return null;
  const kind = cleanStr(raw.kind, 20);
  if (!CATALOG_KINDS.has(kind)) return null;
  const name = cleanStr(raw.name, 60);
  if (!name) return null;
  // Exactly one source for the code: inline (small) or a sibling codes/<id>.txt.
  // An oversized inline code is NEVER truncated (a sliced b64url code decodes
  // to garbage and imports as "not a valid preset") — the entry falls back to
  // its code file when it declares one, else it's dropped as malformed.
  const codeFile = raw.codeFile === true;
  const rawCode = typeof raw.code === 'string' ? raw.code.trim() : '';
  const code = rawCode.length <= CODE_INLINE_MAX ? rawCode : '';
  if (rawCode.length > CODE_INLINE_MAX && !codeFile) return null;
  // A limited-edition drop is reserved via Discord, so it may carry no code at
  // all — every other kind still requires a code source.
  const limited = normalizeLimited(raw.limited);
  if (!code && !codeFile && !limited) return null;
  const entry = {
    id,
    kind,
    name,
    author: cleanStr(raw.author, 60),
    authorSupporter: raw.authorSupporter === true,
    supportersOnly: raw.supportersOnly === true,
    locked: raw.locked === true,
    description: cleanStr(raw.description, DESCRIPTION_MAX),
    addedAt: cleanStr(raw.addedAt, 20),
    appVersionMin: cleanStr(raw.appVersionMin, 20),
    code,
    codeFile,
  };
  // Optional theme-swatch preview: three validated hex colours, nothing else.
  if (raw.preview && typeof raw.preview === 'object' && !Array.isArray(raw.preview)) {
    const p = {};
    for (const key of ['accent', 'bg', 'text']) {
      const v = cleanStr(raw.preview[key], 9);
      if (HEX_COLOR_RE.test(v)) p[key] = v;
    }
    if (Object.keys(p).length) entry.preview = p;
  }
  // ── v2 fields (all optional; a v1 entry is untouched) ──
  const version = cleanStr(raw.version, 20);
  if (VERSION_RE.test(version)) entry.version = version;
  // What changed in this version, shown on the update prompt. Plain text only —
  // it is rendered with textContent, never as markup.
  const changelog = cleanStr(raw.changelog, 300);
  if (changelog) entry.changelog = changelog;
  // Last-modified date, stamped by the hub only when a save really changes the
  // entry. addedAt stays the first-publish date, so the two together let the
  // gallery sort by "recently updated" without lying about a debut.
  const updatedAt = cleanStr(raw.updatedAt, 20);
  if (ISO_DATE_RE.test(updatedAt) && Number.isFinite(Date.parse(updatedAt))) entry.updatedAt = updatedAt;
  // The installed-package id a widget/ambient entry updates (join key for the
  // in-app update check). Only meaningful for code-carrying kinds.
  const pkgId = cleanStr(raw.pkgId, 41);
  if ((kind === 'widget' || kind === 'ambient') && PKG_ID_RE.test(pkgId)) entry.pkgId = pkgId;
  // Performance note stamped by the hub's audit at approve time (admin can
  // override). Boolean-true-only, like the other v2 flags — the gallery shows a
  // "may use more resources" chip and the import dialog repeats it.
  if (raw.perfWarning === true) entry.perfWarning = true;
  // Sold for Sparks (the hub's entries.sparks_price). Only the label and the
  // button come from here: the hub charges, and refuses what is not for sale.
  if (Number.isInteger(raw.sparks) && raw.sparks > 0 && raw.sparks <= SPARKS_MAX) entry.sparks = raw.sparks;
  // When the pass trial may open it; absent means after its first 30 days.
  if (raw.trial === 'now' || raw.trial === 'never') entry.trial = raw.trial;
  // Storefront spotlight, chosen in the hub admin: 'main' leads the Store at full
  // width, 'on' rides in the column beside it. Two literals only — an unknown
  // value must read as "not featured" rather than promote an entry by accident.
  if (raw.featured === 'main' || raw.featured === 'on') entry.featured = raw.featured;
  const category = cleanStr(raw.category, 20);
  if (CATALOG_CATEGORIES.has(category)) entry.category = category;
  if (Array.isArray(raw.tags)) {
    const tags = [];
    for (const tRaw of raw.tags) {
      // Sliced to 21 (not 20) so an over-long tag FAILS the ≤20 regex and is
      // dropped whole, instead of silently truncating into a different tag.
      const tag = cleanStr(tRaw, 21).toLowerCase();
      if (TAG_RE.test(tag) && !tags.includes(tag)) tags.push(tag);
      if (tags.length >= 5) break;
    }
    if (tags.length) entry.tags = tags;
  }
  // Screenshots are a COUNT, never URLs: the client derives the fixed sidecar
  // paths (shots/<id>.webp — with a .png fallback — then shots/<id>-2.webp …
  // shots/<id>-<n>.webp, animated WebP allowed) from the (charset-pinned) entry
  // id, so no attacker-controlled URL is ever rendered. `screenshot: true` (v2)
  // is the legacy single-shot form and still means exactly one shot.
  let shots = 0;
  if (Number.isInteger(raw.shots)) shots = Math.max(0, Math.min(MAX_SHOTS, raw.shots));
  else if (raw.screenshot === true) shots = 1;
  if (shots > 0) { entry.shots = shots; entry.screenshot = true; }
  if (raw.publisher && typeof raw.publisher === 'object' && !Array.isArray(raw.publisher)) {
    const handle = cleanStr(raw.publisher.handle, 40);
    if (HANDLE_RE.test(handle)) {
      entry.publisher = { handle };
      // A publisher link renders as an href only under a scheme+host allowlist:
      // https on github.com, nothing else survives.
      const url = cleanStr(raw.publisher.url, 200);
      try {
        const u = new URL(url);
        if (u.protocol === 'https:' && (u.hostname === 'github.com' || u.hostname === 'www.github.com')) entry.publisher.url = u.toString();
      } catch { /* no url */ }
    }
  }
  if (limited) entry.limited = limited;
  // ── Visibility (all optional; a v1 entry with none is always visible) ──
  // `active` is a HARD override the maintainer flips by hand: true = always show
  // (resurface a retired drop), false = always hide (pull one early). With no
  // override, activeFrom/activeUntil decide. Evaluated at serve time, never here.
  if (raw.active === true || raw.active === false) entry.active = raw.active;
  const activeFrom = cleanStr(raw.activeFrom, 30);
  if (ISO_DATE_RE.test(activeFrom) && Number.isFinite(Date.parse(activeFrom))) entry.activeFrom = activeFrom;
  const activeUntil = cleanStr(raw.activeUntil, 30);
  if (ISO_DATE_RE.test(activeUntil) && Number.isFinite(Date.parse(activeUntil))) entry.activeUntil = activeUntil;
  return entry;
}

// Rebuild the whole catalog. Accepts { entries: [...] } or a bare array.
// Never throws; junk input yields an empty list.
function normalizeCatalog(raw) {
  const list = Array.isArray(raw) ? raw
    : (raw && typeof raw === 'object' && Array.isArray(raw.entries)) ? raw.entries : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (out.length >= MAX_ENTRIES) break;
    const entry = normalizeEntry(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

// Is an entry currently listable? `active` (when present) is a hard override;
// otherwise the [activeFrom, activeUntil] date window decides. Pure — takes the
// clock so it stays testable and is evaluated per request (never cached).
function isEntryVisible(entry, now) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.active === false) return false;   // manually pulled
  if (entry.active === true) return true;      // manually resurfaced
  if (entry.activeFrom) { const t = Date.parse(entry.activeFrom); if (Number.isFinite(t) && now < t) return false; }
  if (entry.activeUntil) { const t = Date.parse(entry.activeUntil); if (Number.isFinite(t) && now > t) return false; }
  return true;
}
function filterVisibleEntries(entries, now) {
  return Array.isArray(entries) ? entries.filter((e) => isEntryVisible(e, now)) : [];
}

function normalizeCodeId(value) {
  const id = cleanStr(value, 61);
  return ENTRY_ID_RE.test(id) ? id : null;
}

module.exports = {
  MAX_ENTRIES, CODE_INLINE_MAX, CATALOG_KINDS, ENTRY_ID_RE, HEX_COLOR_RE, VERSION_RE, PKG_ID_RE,
  TAG_RE, HANDLE_RE, CATALOG_CATEGORIES, ISO_DATE_RE, MAX_SHOTS, SPARKS_MAX, cleanStr,
  normalizeLimited, normalizeEntry, normalizeCatalog, isEntryVisible, filterVisibleEntries,
  normalizeCodeId,
};
