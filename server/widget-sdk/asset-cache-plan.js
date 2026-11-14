'use strict';
// Decides what the widgets' picture cache keeps: the size and count limits per package and in
// all, the name a cached file gets, and which files go first.

const crypto = require('node:crypto');

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

module.exports = {
  MAX_BYTES_PER_PKG, MAX_BYTES_TOTAL, MAX_ENTRIES_PER_PKG, MIME_EXT, FILE_RE, keyFor, extFor,
  planEviction, planGlobalEviction,
};
