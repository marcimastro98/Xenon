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

require('./net-guard'); // nothing is taken from it here, but it runs code when it loads
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

// The storefront layout — which sections the Store shows, in what order and in
// what shape — travels in the catalog alongside `entries`, and the same contract
// is read by the website catalog and written by the hub admin. Loaded through the
// server/shared junction (→ packages/core).
//
// Guarded on purpose: a checkout whose `npm install` postinstall has not run yet
// has no junction, and a bare require would throw at module load and take the
// whole server down for what is a cosmetic ordering feature. Without it the
// catalog simply carries no layout and both storefronts fall back to their
// default order — which is exactly what the contract promises for absent input.
let storefront = null;
try { storefront = require('./shared/src/storefront-layout.js'); }
catch { storefront = null; }

require('./store-catalog/description-limit.js'); // nothing is taken from it here, but it runs code when it loads

const CATALOG_BASE = 'https://xenon-app.com/community/';
const CATALOG_URL = CATALOG_BASE + 'catalog.json';

const { fetchText } = require('./store-catalog/catalog-fetch.js');
// One shared code file. 4 MB since v4.11.10 (was 2): a remote-locked bundle carrying a theme
// with painted backdrop images, a widget AND an Ambient scene lands around 3.5 MB, because
// locking inflates a code by ~78%. Matches the import dialog's own 4 MB ceiling
// (MAX_CODE_BYTES in js/preset-share.js) and the hub's MAX_CODE. An entry whose code is over
// the old 2 MB must carry appVersionMin 4.11.10, or older installs refuse it as bad_code.
const MAX_CODE_BYTES = 4 * 1024 * 1024;
const CATALOG_TTL_MS = 45 * 60 * 1000;
const REFRESH_MIN_INTERVAL_MS = 60 * 1000; // ?refresh=1 can't hammer the site
const CODE_REVALIDATE_MS = 60 * 1000;      // serve a cached code blind for this long, then revalidate (etag) every request
const {
  normalizeEntry, normalizeCatalog, isEntryVisible, filterVisibleEntries, normalizeCodeId,
} = require('./store-catalog/catalog-entry-clean.js');
const CODE_CACHE_MAX = 6;       // up to 6 x MAX_CODE_BYTES held in memory


// Rebuild the storefront layout the same way: bounded, key-by-key, never spread.
// All of that already lives in the shared contract (unknown block types dropped,
// duplicates collapsed, numbers clamped, a hard cap on how many blocks are read),
// so this is only the boundary that decides whether we have a contract to apply.
// Returns null when the module is unavailable — the storefronts then use their own
// default order, which is the same answer they give for an absent layout.
function normalizeCatalogLayout(raw) {
  if (!storefront) return null;
  try { return storefront.normalizeLayout(raw); }
  catch { return null; }
}


function cacheIsFresh(cache, now, ttl = CATALOG_TTL_MS) {
  return !!(cache && Array.isArray(cache.entries) && (now - cache.fetchedAt) < ttl);
}

// ── Catalog cache (module-level, request-driven, disk-backed) ────────────────
let _catalogCache = null;   // { entries, fetchedAt, etag }
let _catalogPending = null; // in-flight dedup
let _lastForcedAt = 0;
let _cacheFile = null;      // set by initCache(); null = memory-only (unit tests)
let _fetchImpl = fetchText; // injectable so the SWR flow is testable without a network
let _appVersion = '';       // the build that writes the disk copy (initCache)

// Load the last-good catalog from disk at startup. The in-memory cache used to
// die with the process, so the FIRST open after every server restart re-blocked
// on the 8s upstream fetch and showed "could not load the gallery" whenever the
// site was momentarily unreachable — the "lots of gallery errors" report. A
// disk copy lets the Store open instantly and offline right after a restart.
function initCache(opts) {
  const dir = opts && opts.dataDir;
  if (!dir) return;
  _cacheFile = path.join(dir, 'community-catalog-cache.json');
  _appVersion = typeof opts.appVersion === 'string' ? opts.appVersion : '';
  try {
    const raw = JSON.parse(fs.readFileSync(_cacheFile, 'utf8'));
    if (raw && Array.isArray(raw.entries)) {
      // Re-normalize on load: the persisted copy could predate a schema change,
      // and it is re-validated key-by-key exactly like a fresh network fetch.
      // A copy written by another build lost every field that build's normalizer
      // did not know (4.11.13 dropped `sparks`, so 5.0.0 showed Sparks drops as
      // supporter drops), and its etag would get a 304 that keeps it forever.
      // So it is only a fallback: no etag, and the first read awaits a full fetch.
      const sameBuild = !!_appVersion && raw.appVersion === _appVersion;
      _catalogCache = {
        entries: normalizeCatalog(raw.entries),
        layout: normalizeCatalogLayout(raw.layout),
        fetchedAt: sameBuild ? Number(raw.fetchedAt) || 0 : 0,
        etag: sameBuild && typeof raw.etag === 'string' ? raw.etag : '',
        otherBuild: !sameBuild,
      };
    }
  } catch { /* absent or corrupt — start cold; the first fetch repopulates it */ }
}

function _persistCatalogCache() {
  if (!_cacheFile || !_catalogCache) return;
  const snapshot = JSON.stringify({
    entries: _catalogCache.entries,
    layout: _catalogCache.layout,
    fetchedAt: _catalogCache.fetchedAt,
    etag: _catalogCache.etag,
    appVersion: _appVersion,
  });
  try { writeFileAtomic(_cacheFile, snapshot).catch(() => {}); }
  catch { /* best-effort — the memory copy still serves this run */ }
}

// The actual upstream fetch + cache update, dedup'd via _catalogPending. Never
// throws: a failure with a cache degrades to the last good copy, a cold failure
// returns { ok: false }.
function _revalidateCatalog(doForce) {
  if (_catalogPending) return _catalogPending;
  _catalogPending = (async () => {
    try {
      const resp = await _fetchImpl(CATALOG_URL, _catalogCache && !doForce ? { etag: _catalogCache.etag } : null);
      if (resp.notModified && _catalogCache) {
        _catalogCache.fetchedAt = Date.now();
        _persistCatalogCache();
        return { ok: true, entries: _catalogCache.entries, cached: true };
      }
      let parsed;
      try { parsed = JSON.parse(resp.text || ''); } catch { throw new Error('bad catalog JSON'); }
      const entries = normalizeCatalog(parsed);
      const layout = normalizeCatalogLayout(parsed && parsed.layout);
      _catalogCache = { entries, layout, fetchedAt: Date.now(), etag: resp.etag || '' };
      _persistCatalogCache();
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

async function fetchCatalog(force) {
  const now = Date.now();
  // Share an in-flight fetch BEFORE consuming the force budget — a ↻ tap that
  // lands mid-fetch shouldn't burn the once-a-minute allowance on a request it
  // didn't start.
  if (_catalogPending) return _catalogPending;
  const doForce = force && (now - _lastForcedAt) >= REFRESH_MIN_INTERVAL_MS;
  if (doForce) _lastForcedAt = now;
  // A disk copy from another build is never served as is (see initCache).
  const otherBuild = !!(_catalogCache && _catalogCache.otherBuild);
  if (!doForce && !otherBuild && cacheIsFresh(_catalogCache, now)) {
    return { ok: true, entries: _catalogCache.entries, cached: true };
  }
  // Stale-while-revalidate: a cache exists but is past its TTL. Serve the last
  // good copy IMMEDIATELY and refresh in the background, so opening the Store is
  // never blocked on the upstream fetch (the "loading takes lots of time"
  // report). Only a truly cold cache — fresh install, or a restart with no
  // persisted copy — awaits the network, the one case with nothing to show. A
  // manual ↻ (doForce) always awaits, so the user who asked for fresh data gets it.
  const haveCache = !!(_catalogCache && Array.isArray(_catalogCache.entries));
  const revalidate = _revalidateCatalog(doForce);
  if (haveCache && !doForce && !otherBuild) {
    return { ok: true, entries: _catalogCache.entries, cached: true, revalidating: true };
  }
  return revalidate;
}

// The catalog with hidden/scheduled entries dropped — what every CONSUMER (the
// gallery, AI marketplace tools) should see. Filtered at serve time off the full
// cached list, so toggling `active` or crossing a date boundary takes effect on
// the next request without waiting for the TTL to lapse.
async function fetchVisibleCatalog(force) {
  const out = await fetchCatalog(force);
  if (out && out.ok && Array.isArray(out.entries)) {
    // The layout rides out from HERE and nowhere else. fetchCatalog has six
    // return paths (fresh, cached, 304, stale-while-revalidate, degraded,
    // cold-fail) and threading it through each is how one of them ends up
    // silently dropping it; every consumer goes through this one boundary.
    // Absent (no shared module, or a cold failure with nothing cached) is a
    // valid answer — the client's own fallback covers it.
    // Wire shape is catalog.json's own — `{ blocks: [...] }`, not a bare array —
    // so the client calls the SAME normalizeLayout(out.layout) the website calls
    // on the raw file, instead of an app-only spelling that has to be remembered
    // in two places. Re-normalizing an already-normalized list is a no-op.
    const layout = _catalogCache && _catalogCache.layout;
    return {
      ...out,
      entries: filterVisibleEntries(out.entries, Date.now()),
      ...(layout ? { layout: { blocks: layout } } : null),
    };
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
  // Only the first CODE_REVALIDATE_MS are served blind, to absorb rapid reopens.
  // After that we revalidate with a conditional GET (etag) on every request: a
  // 304 keeps the cached copy cheaply, a changed file replaces it. A bundle can
  // be re-published (e.g. re-encrypted with a new key) and be live within ~a
  // minute, not 45 — the earlier CATALOG_TTL_MS window meant a supporter who had
  // opened the entry once kept the stale, undecryptable bundle for that long.
  if (hit && (now - hit.fetchedAt) < CODE_REVALIDATE_MS) {
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
  normalizeCatalogLayout,
  normalizeEntry,
  normalizeCodeId,
  isEntryVisible,
  filterVisibleEntries,
  cacheIsFresh,
  initCache,
  fetchCatalog,
  fetchVisibleCatalog,
  fetchCode,
  fetchText,
  // Test seams (mirrors community-installs.js): inject the upstream fetcher and
  // reset the module cache so the SWR flow can be exercised without a network.
  _setFetcher(fn) { _fetchImpl = fn || fetchText; },
  _resetCache() { _catalogCache = null; _catalogPending = null; _lastForcedAt = 0; _cacheFile = null; _appVersion = ''; },
  _expireCache() { if (_catalogCache) _catalogCache.fetchedAt = 0; },   // age past the TTL for tests
};
