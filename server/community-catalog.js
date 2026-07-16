'use strict';
// Community gallery catalog — server-side fetch + validation.
//
// The catalog is a static JSON published with the project site (GitHub Pages,
// docs/community/catalog.json) and moderated by the maintainer via PRs. The
// dashboard never renders it raw: every entry is rebuilt key-by-key here
// (never spread), and installing an entry ALWAYS goes through the normal
// import pipeline client-side (PresetShare.openImport → per-kind preview and
// permission dialogs → the same /sdk/install / normalizer boundaries).
//
// Fetch shape mirrors ics-feeds.js: https-only conditional GET (ETag/304),
// bounded body, redirect cap, timeout — plus a module-level TTL cache with
// in-flight dedup so a burst of clients costs one request. No periodic work:
// the catalog is fetched only when someone opens the gallery.
//
// Pure parts (normalizeCatalog, normalizeCodeId, cacheIsFresh) are exported
// for unit tests (server/test/community-catalog.test.mjs).

const https = require('https');

const CATALOG_BASE = 'https://xenon-app.com/community/';
const CATALOG_URL = CATALOG_BASE + 'catalog.json';

const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;   // catalog JSON — generous, rejects absurd payloads
const MAX_CODE_BYTES = 2 * 1024 * 1024;   // one shared code file
const CATALOG_TTL_MS = 45 * 60 * 1000;
const REFRESH_MIN_INTERVAL_MS = 60 * 1000; // ?refresh=1 can't hammer the site
const MAX_ENTRIES = 200;
const CODE_CACHE_MAX = 10;
const CODE_INLINE_MAX = 8000;   // longer codes must ship as codes/<id>.txt

// Kinds the gallery may list — the import pipeline's PRESET_KINDS.
// Keep in step with PRESET_KINDS (js/preset-share.js), the hub admin's KINDS
// (xenon-supporter-hub src/catalog-admin.js), the issue-template dropdown and
// the website gallery's KINDS (docs/catalog/index.html). 'ambient-layout' is
// deliberately not catalog-listable.
const CATALOG_KINDS = new Set(['theme', 'page', 'deck', 'bundle', 'bg', 'widget', 'ambient', 'icons', 'sounds']);

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

function cleanStr(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Limited-edition drop metadata (optional, additive). A limited entry is a
// curated pack sold in a fixed number of copies and RESERVED via Discord, not
// imported directly — so it may legitimately carry no share code. total/claimed
// are bounded integer counts; `left`/`soldOut` are derived server-side so the
// client never computes availability itself. `reserveUrl` renders as an href
// only under an https + Discord-host allowlist (same shape as the publisher.url
// github guard) — anything else is dropped and the client falls back to the
// project Discord invite.
function normalizeLimited(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const total = Number.isInteger(raw.total) ? Math.max(0, Math.min(99999, raw.total)) : 0;
  if (total <= 0) return null;
  const claimed = Number.isInteger(raw.claimed) ? Math.max(0, Math.min(total, raw.claimed)) : 0;
  const lim = { total, claimed, left: total - claimed, soldOut: claimed >= total };
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
    description: cleanStr(raw.description, 300),
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
  // The installed-package id a widget/ambient entry updates (join key for the
  // in-app update check). Only meaningful for code-carrying kinds.
  const pkgId = cleanStr(raw.pkgId, 41);
  if ((kind === 'widget' || kind === 'ambient') && PKG_ID_RE.test(pkgId)) entry.pkgId = pkgId;
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

function cacheIsFresh(cache, now, ttl = CATALOG_TTL_MS) {
  return !!(cache && Array.isArray(cache.entries) && (now - cache.fetchedAt) < ttl);
}

// ── HTTPS conditional GET ────────────────────────────────────────────────────
// Mirrors fetchFeedConditional in ics-feeds.js (same redirect cap, timeout,
// body cap, ETag/304 handling) — the codebase convention for these fetchers is
// a documented mirror (see stocks.js fetchJson). If you harden one, harden all.
function fetchText(url, validators, _hops = 0) {
  return new Promise((resolve, reject) => {
    if (_hops > 5) return reject(new Error('too many redirects'));
    if (!/^https:\/\//i.test(url)) return reject(new Error('https only'));
    const headers = {};
    if (validators && validators.etag) headers['If-None-Match'] = validators.etag;
    let req;
    try { req = https.get(url, { timeout: FETCH_TIMEOUT_MS, headers }, onResponse); }
    catch (e) { return reject(e); }
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);

    function onResponse(res) {
      if (res.statusCode === 304) { res.resume(); return resolve({ notModified: true }); }
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchText(new URL(res.headers.location, url).toString(), validators, _hops + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const etag = res.headers.etag || '';
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) { req.destroy(new Error('body too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ notModified: false, text: Buffer.concat(chunks).toString('utf8'), etag }));
      res.on('error', reject);
    }
  });
}

// ── Catalog cache (module-level, request-driven) ─────────────────────────────
let _catalogCache = null;   // { entries, fetchedAt, etag }
let _catalogPending = null; // in-flight dedup
let _lastForcedAt = 0;

async function fetchCatalog(force) {
  const now = Date.now();
  // Share an in-flight fetch BEFORE consuming the force budget — a ↻ tap that
  // lands mid-fetch shouldn't burn the once-a-minute allowance on a request it
  // didn't start.
  if (_catalogPending) return _catalogPending;
  const doForce = force && (now - _lastForcedAt) >= REFRESH_MIN_INTERVAL_MS;
  if (doForce) _lastForcedAt = now;
  if (!doForce && cacheIsFresh(_catalogCache, now)) {
    return { ok: true, entries: _catalogCache.entries, cached: true };
  }
  _catalogPending = (async () => {
    try {
      const resp = await fetchText(CATALOG_URL, _catalogCache && !doForce ? { etag: _catalogCache.etag } : null);
      if (resp.notModified && _catalogCache) {
        _catalogCache.fetchedAt = Date.now();
        return { ok: true, entries: _catalogCache.entries, cached: true };
      }
      let parsed;
      try { parsed = JSON.parse(resp.text || ''); } catch { throw new Error('bad catalog JSON'); }
      const entries = normalizeCatalog(parsed);
      _catalogCache = { entries, fetchedAt: Date.now(), etag: resp.etag || '' };
      return { ok: true, entries, cached: false };
    } catch (e) {
      // Degrade to the last good copy when the network is down.
      if (_catalogCache) return { ok: true, entries: _catalogCache.entries, cached: true, stale: true };
      return { ok: false, error: String(e && e.message || e).slice(0, 200), entries: [] };
    } finally {
      _catalogPending = null;
    }
  })();
  return _catalogPending;
}

// The catalog with hidden/scheduled entries dropped — what every CONSUMER (the
// gallery, AI marketplace tools) should see. Filtered at serve time off the full
// cached list, so toggling `active` or crossing a date boundary takes effect on
// the next request without waiting for the TTL to lapse.
async function fetchVisibleCatalog(force) {
  const out = await fetchCatalog(force);
  if (out && out.ok && Array.isArray(out.entries)) {
    return { ...out, entries: filterVisibleEntries(out.entries, Date.now()) };
  }
  return out;
}

// ── Per-entry code files (codes/<id>.txt) — tiny LRU with TTL + revalidation ──
// A code file is MUTABLE in place: the maintainer republishes codes/<id>.txt to
// ship a widget/scene update at the SAME URL (the in-app update check keys on the
// catalog's pkgId+version). A forever-cache would therefore pin the stale build —
// the user taps "Update", the old code reinstalls, and the badge never clears.
// So each entry carries the catalog TTL and, once stale, revalidates with a
// conditional GET (ETag/304) exactly like fetchCatalog above.
const _codeCache = new Map(); // id → { text, fetchedAt, etag }

async function fetchCode(id) {
  const safeId = normalizeCodeId(id);
  if (!safeId) return { ok: false, error: 'bad_id' };
  const now = Date.now();
  const hit = _codeCache.get(safeId);
  if (hit && (now - hit.fetchedAt) < CATALOG_TTL_MS) {
    _codeCache.delete(safeId); _codeCache.set(safeId, hit);   // refresh LRU order
    return { ok: true, code: hit.text };
  }
  try {
    const resp = await fetchText(CATALOG_BASE + 'codes/' + safeId + '.txt', hit ? { etag: hit.etag } : null);
    if (resp.notModified && hit) {
      hit.fetchedAt = now;
      _codeCache.delete(safeId); _codeCache.set(safeId, hit);
      return { ok: true, code: hit.text };
    }
    const code = String(resp.text || '').trim();
    if (!code || code.length > MAX_CODE_BYTES) return { ok: false, error: 'bad_code' };
    _codeCache.set(safeId, { text: code, fetchedAt: now, etag: resp.etag || '' });
    if (_codeCache.size > CODE_CACHE_MAX) _codeCache.delete(_codeCache.keys().next().value);
    return { ok: true, code };
  } catch (e) {
    // Degrade to the last good copy when the network is down (mirrors fetchCatalog).
    if (hit) return { ok: true, code: hit.text };
    return { ok: false, error: String(e && e.message || e).slice(0, 200) };
  }
}

module.exports = {
  CATALOG_BASE,
  CATALOG_URL,
  CATALOG_TTL_MS,
  normalizeCatalog,
  normalizeEntry,
  normalizeCodeId,
  isEntryVisible,
  filterVisibleEntries,
  cacheIsFresh,
  fetchCatalog,
  fetchVisibleCatalog,
  fetchCode,
};
