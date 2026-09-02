'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// sdk-asset-cache.js — the disk half of the SDK image cache (GET /sdk/asset/…).
//
// Why it exists. A widget that shows album art, game art or video thumbnails
// can only keep them today by base64-ing them into its store, which caps a
// value at 16 KB and the whole store at 256 KB — so nothing real fits. The map
// route already solved the *transport* (same-origin <img>, no base64) but its
// cache is memory-only, 256 entries, ten minutes: right for radar frames that
// change every few minutes, useless for a cover that never changes. This adds
// the persistent tier, behind the same door.
//
// Why the bounds are the feature. Asked for by a widget author who had built
// this himself and flagged the hole in his own design: his index kept 512
// entries per widget, but nothing deleted the FILES. An entry pushed out of the
// index leaves a file that nothing can ever find again to delete. With 96
// packages allowed and a 1 MB response cap that is ~49 GB of tracked files plus
// an unbounded tail of invisible ones, on someone else's disk, for artwork.
//
// So eviction here always means the file too, expiry is enforced rather than
// merely recorded, and a sweep deletes anything on disk the index does not
// know about. Two caps, because one is not enough: a per-package cap stops one
// widget hoarding, and a total cap stops ninety-six well-behaved ones adding up
// to the same problem.
//
// planEviction() is pure and holds all of that reasoning. It is the part worth
// testing, and the part worth reading.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// A cover does not change often, but it does change — and it can change behind
// the SAME url, which no key can notice. Seven days is the compromise: long
// enough that a library the user browses daily is served from disk, short
// enough that a replaced cover is not wrong for a month.
const POSITIVE_TTL_MS = 7 * 24 * 3600 * 1000;
// A 404 on artwork is usually transient (a CDN warming, a rename mid-flight), so
// remembering it for hours would turn a blip into an afternoon of blank tiles.
// One hour is enough to stop a render loop hammering a dead url.
const NEGATIVE_TTL_MS = 60 * 60 * 1000;
// Bytes, not entries: entries are metadata and cost nothing, files are the
// thing that fills a disk.
//
// 64 MB, and the number is measured rather than guessed. It started at 32,
// derived from artwork at 20-30 KB — which is what album and game art actually
// weighs, confirmed by the widget author who asked for this. Then he corrected
// it: ARTIST covers are a different animal and reach 200 KB. A realistic mixed
// library (500 albums plus 100 artists) lands at 31.7 MB, which is to say
// exactly on the old cap — a heavy user would have sat permanently at the
// eviction boundary, re-downloading what they had just been shown. That is the
// one failure mode a cache exists to avoid.
//
// The TOTAL is deliberately not doubled with it. The per-package cap stops one
// widget crowding out the others; the total is what protects the disk, and it
// is the one a user would notice. One widget may now claim a quarter of it.
const MAX_BYTES_PER_PKG = 64 * 1024 * 1024;
// And the sum of them. 96 packages each holding their per-package cap would be
// 3 GB, which is not a defensible number for a picture cache, so the total is
// enforced independently and evicts the globally least-recently-used.
const MAX_BYTES_TOTAL = 256 * 1024 * 1024;
// A ceiling on the index itself, so a pathological widget cannot make loading
// its metadata expensive. The byte caps bite long before this on real content.
const MAX_ENTRIES_PER_PKG = 4000;

// Only formats a browser will render as an image from an <img>. The extension
// is derived from the content type WE validated, never from the url, so a
// filename can never carry an attacker's choice of suffix.
const MIME_EXT = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
});
const FILE_RE = /^[a-f0-9]{64}\.(jpg|png|webp|gif|avif)$/;
const PKG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

function keyFor(url) {
  return crypto.createHash('sha256').update(String(url)).digest('hex');
}

function extFor(contentType) {
  return MIME_EXT[String(contentType || '').split(';')[0].trim().toLowerCase()] || null;
}

/**
 * What to drop, and why, given what a package holds right now.
 *
 * Order matters and is not arbitrary:
 *   1. anything malformed — an entry whose file name does not match the one
 *      shape we ever write is not ours, and is never served or trusted;
 *   2. anything expired — enforced here rather than only at read time, so a
 *      cache nobody reads still shrinks;
 *   3. least recently USED, until under the entry cap and the byte cap.
 *
 * Least-recently-used and not least-recently-written: a cover fetched once and
 * shown every day should outlive one fetched yesterday and never looked at
 * again. `lastUsedAt` is what a hit updates.
 *
 * Pure: takes the entry map, returns the keys to remove. The caller deletes the
 * files, so a test can reason about the policy without a filesystem.
 */
function planEviction(entries, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const maxBytes = Number.isFinite(o.maxBytes) ? o.maxBytes : MAX_BYTES_PER_PKG;
  const maxEntries = Number.isFinite(o.maxEntries) ? o.maxEntries : MAX_ENTRIES_PER_PKG;

  const drop = new Set();
  const live = [];
  let bytes = 0;

  for (const [key, e] of Object.entries(entries || {})) {
    if (!e || typeof e !== 'object') { drop.add(key); continue; }
    if (e.status === 'negative') {
      // Negative entries hold no file, so they only ever cost index space.
      if (!(Number(e.expiresAt) > now)) drop.add(key);
      else live.push({ key, bytes: 0, lastUsedAt: Number(e.lastUsedAt) || Number(e.at) || 0 });
      continue;
    }
    if (e.status !== 'positive' || !FILE_RE.test(String(e.file || ''))) { drop.add(key); continue; }
    if (!(Number(e.expiresAt) > now)) { drop.add(key); continue; }
    const size = Math.max(0, Number(e.bytes) || 0);
    bytes += size;
    live.push({ key, bytes: size, lastUsedAt: Number(e.lastUsedAt) || Number(e.at) || 0 });
  }

  // Oldest use first — the next one out.
  live.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  let i = 0;
  while (i < live.length && (live.length - i > maxEntries || bytes > maxBytes)) {
    bytes -= live[i].bytes;
    drop.add(live[i].key);
    i++;
  }
  return Array.from(drop);
}

/**
 * The same decision across every package, for the total cap. Takes one entry
 * per candidate as { pkgId, key, bytes, lastUsedAt } and returns the ones to
 * drop — globally least-recently-used first, so a widget nobody looks at loses
 * its artwork before one in daily use.
 */
function planGlobalEviction(all, maxBytesTotal) {
  const cap = Number.isFinite(maxBytesTotal) ? maxBytesTotal : MAX_BYTES_TOTAL;
  let bytes = 0;
  for (const e of all) bytes += Math.max(0, Number(e.bytes) || 0);
  if (bytes <= cap) return [];
  const sorted = all.slice().sort((a, b) => (Number(a.lastUsedAt) || 0) - (Number(b.lastUsedAt) || 0));
  const drop = [];
  for (const e of sorted) {
    if (bytes <= cap) break;
    bytes -= Math.max(0, Number(e.bytes) || 0);
    drop.push(e);
  }
  return drop;
}

// ── The disk side ────────────────────────────────────────────────────────────
// Everything above is policy; this is the part that touches files. It is small
// on purpose: one directory per package, one index beside the files, and every
// removal deleting both.

const { writeFileAtomic } = require('./atomic-write');

function createAssetStore(options) {
  const o = options || {};
  const root = String(o.root || '');
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const maxBytesPerPkg = Number.isFinite(o.maxBytesPerPkg) ? o.maxBytesPerPkg : MAX_BYTES_PER_PKG;
  const maxBytesTotal = Number.isFinite(o.maxBytesTotal) ? o.maxBytesTotal : MAX_BYTES_TOTAL;
  const positiveTtlMs = Number.isFinite(o.positiveTtlMs) ? o.positiveTtlMs : POSITIVE_TTL_MS;
  const negativeTtlMs = Number.isFinite(o.negativeTtlMs) ? o.negativeTtlMs : NEGATIVE_TTL_MS;

  const dirFor = (pkgId) => path.join(root, pkgId);
  const indexFile = (pkgId) => path.join(root, pkgId, 'index.json');

  // A package id reaches here straight from a URL path. It is validated against
  // the same shape the SDK uses everywhere else BEFORE it is ever joined onto a
  // path, so no traversal can be spelled: no dots, no slashes, no separators.
  const validPkg = (pkgId) => PKG_RE.test(String(pkgId || ''));

  async function readIndex(pkgId) {
    try {
      const raw = await fs.promises.readFile(indexFile(pkgId), 'utf8');
      const v = JSON.parse(raw);
      if (v && typeof v === 'object' && v.entries && typeof v.entries === 'object') return v;
    } catch { /* absent or unreadable — an empty cache is always a valid answer */ }
    return { version: 1, entries: {} };
  }

  async function writeIndex(pkgId, index) {
    await fs.promises.mkdir(dirFor(pkgId), { recursive: true, mode: 0o700 });
    await writeFileAtomic(indexFile(pkgId), JSON.stringify({ version: 1, entries: index.entries }));
  }

  // Apply an eviction plan: the index entry AND its file, in that order. The
  // file going last means a crash between them leaves an orphan, which the
  // sweep collects — the other order would leave an index pointing at nothing,
  // which is served as a broken image.
  async function applyPlan(pkgId, index, keys) {
    for (const key of keys) {
      const e = index.entries[key];
      delete index.entries[key];
      if (e && e.status === 'positive' && FILE_RE.test(String(e.file || ''))) {
        try { await fs.promises.unlink(path.join(dirFor(pkgId), e.file)); } catch { /* already gone */ }
      }
    }
    return keys.length;
  }

  return {
    /** A hit, a remembered failure, or null. Touches lastUsedAt so eviction is a real LRU. */
    async get(pkgId, url) {
      if (!validPkg(pkgId)) return null;
      const index = await readIndex(pkgId);
      const key = keyFor(url);
      const e = index.entries[key];
      if (!e || !(Number(e.expiresAt) > now())) return null;
      if (e.status === 'negative') return { negative: true, status: Number(e.httpStatus) || 404 };
      if (e.status !== 'positive' || !FILE_RE.test(String(e.file || ''))) return null;
      let buffer;
      try { buffer = await fs.promises.readFile(path.join(dirFor(pkgId), e.file)); }
      catch { delete index.entries[key]; await writeIndex(pkgId, index).catch(() => {}); return null; }
      // Written back so a busy cache does not lose its own access order. Cheap:
      // the index is small and the write is atomic.
      e.lastUsedAt = now();
      writeIndex(pkgId, index).catch(() => {});
      return { buffer, contentType: e.contentType };
    },

    /** Store an image and bring the package back under its caps. */
    async put(pkgId, url, contentType, buffer) {
      if (!validPkg(pkgId) || !Buffer.isBuffer(buffer)) return false;
      const ext = extFor(contentType);
      if (!ext) return false;
      const key = keyFor(url);
      const file = key + '.' + ext;
      const at = now();
      await fs.promises.mkdir(dirFor(pkgId), { recursive: true, mode: 0o700 });
      await writeFileAtomic(path.join(dirFor(pkgId), file), buffer);
      const index = await readIndex(pkgId);
      index.entries[key] = {
        status: 'positive', url: String(url).slice(0, 2048), file,
        contentType: String(contentType).split(';')[0].trim().toLowerCase(),
        bytes: buffer.length, at, lastUsedAt: at, expiresAt: at + positiveTtlMs,
      };
      await applyPlan(pkgId, index, planEviction(index.entries, { now: at, maxBytes: maxBytesPerPkg }));
      await writeIndex(pkgId, index);
      return true;
    },

    /** Remember a failure briefly, so a render loop stops re-asking for a dead url. */
    async putNegative(pkgId, url, httpStatus) {
      if (!validPkg(pkgId)) return false;
      const at = now();
      const index = await readIndex(pkgId);
      index.entries[keyFor(url)] = {
        status: 'negative', url: String(url).slice(0, 2048),
        httpStatus: Number(httpStatus) || 502, at, lastUsedAt: at, expiresAt: at + negativeTtlMs,
      };
      await applyPlan(pkgId, index, planEviction(index.entries, { now: at, maxBytes: maxBytesPerPkg }));
      await writeIndex(pkgId, index);
      return true;
    },

    /** Everything the caller no longer has a widget for. Called when packages change. */
    async dropPackages(keepIds) {
      const keep = new Set((keepIds || []).map(String));
      let removed = 0;
      let dirs = [];
      try { dirs = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return 0; }
      for (const d of dirs) {
        if (!d.isDirectory() || keep.has(d.name)) continue;
        try { await fs.promises.rm(path.join(root, d.name), { recursive: true, force: true }); removed++; } catch { /* next */ }
      }
      return removed;
    },

    /**
     * The periodic pass. Three jobs no single request can do:
     *   - expire and evict per package, deleting files;
     *   - delete files no index knows about (the orphans an interrupted write or
     *     an older, index-only eviction left behind);
     *   - enforce the TOTAL cap across packages, globally least-recently-used.
     */
    async sweep() {
      const at = now();
      const out = { files: 0, bytes: 0, packages: 0 };
      let dirs = [];
      try { dirs = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return out; }
      const global = [];
      for (const d of dirs) {
        if (!d.isDirectory() || !validPkg(d.name)) continue;
        out.packages++;
        const pkgId = d.name;
        const index = await readIndex(pkgId);
        await applyPlan(pkgId, index, planEviction(index.entries, { now: at, maxBytes: maxBytesPerPkg }));

        // Orphans: on disk, unknown to the index. This is the half the request
        // path can never do, and the half whose absence made the original
        // proposal unbounded.
        const known = new Set(Object.values(index.entries).map((e) => e && e.file).filter(Boolean));
        let files = [];
        try { files = await fs.promises.readdir(dirFor(pkgId)); } catch { files = []; }
        for (const f of files) {
          if (f === 'index.json' || known.has(f)) continue;
          try {
            const st = await fs.promises.stat(path.join(dirFor(pkgId), f));
            await fs.promises.unlink(path.join(dirFor(pkgId), f));
            out.files++; out.bytes += st.size;
          } catch { /* raced with something else */ }
        }
        await writeIndex(pkgId, index);
        for (const [key, e] of Object.entries(index.entries)) {
          if (e && e.status === 'positive') {
            global.push({ pkgId, key, bytes: Number(e.bytes) || 0, lastUsedAt: Number(e.lastUsedAt) || 0 });
          }
        }
      }

      const overflow = planGlobalEviction(global, maxBytesTotal);
      if (overflow.length) {
        const byPkg = new Map();
        for (const e of overflow) {
          if (!byPkg.has(e.pkgId)) byPkg.set(e.pkgId, []);
          byPkg.get(e.pkgId).push(e.key);
        }
        for (const [pkgId, keys] of byPkg) {
          const index = await readIndex(pkgId);
          for (const key of keys) out.bytes += Number((index.entries[key] || {}).bytes) || 0;
          out.files += await applyPlan(pkgId, index, keys);
          await writeIndex(pkgId, index);
        }
      }
      return out;
    },
  };
}

module.exports = {
  createAssetStore,
  POSITIVE_TTL_MS, NEGATIVE_TTL_MS,
  MAX_BYTES_PER_PKG, MAX_BYTES_TOTAL, MAX_ENTRIES_PER_PKG,
  MIME_EXT, FILE_RE, PKG_RE,
  keyFor, extFor, planEviction, planGlobalEviction,
};
