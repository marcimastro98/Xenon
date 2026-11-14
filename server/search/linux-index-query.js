'use strict';
// Answers a file search from the Linux file index: how well a name matches what was typed, and
// the matches in order.

const path = require('node:path');

// What a name is MATCHED on: lowercase with accents stripped. The server
// strips accents from every typed term ("città" → "citta"), so a name kept
// with its accents could never match it.
function foldName(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// 0 exact · 1 prefix · 2 word boundary · 3 substring · -1 miss — the tiers the
// Windows and macOS hosts use, so every platform hands the ranker its BEST
// candidates instead of the first ones the walk met.
function matchTier(nl, t) {
  const idx = nl.indexOf(t);
  if (idx < 0) return -1;
  if (idx === 0) {
    if (nl.length === t.length) return 0;
    if (nl.lastIndexOf('.') === t.length) return 0; // exact up to the extension
    return 1;
  }
  return ' -_.('.includes(nl[idx - 1]) ? 2 : 3;
}

// The worst term's tier, or -1 when the entry does not pass. `before` is
// exclusive (the start of the NEXT day/month), as on the other hosts.
// With `opt.pathTerms`, a term the name lacks may be held by a folder above
// the file ("downloads invoice" → ~/Downloads/invoice.pdf), as on the Windows
// host: tier PATH_TIER, counted in `opt.pt`, and never every term (one must be
// in the name). search-rank.js scores such a term below any name match.
const PATH_TIER = 4;
function entryTier(entry, terms, exts, after, before, minBytes, maxBytes, opt) {
  if (entry.x) return -1;
  if (exts && exts.length) {
    if (entry.d) return -1;
    const ext = path.extname(entry.n).slice(1).toLowerCase();
    if (!exts.includes(ext)) return -1;
  }
  if (typeof minBytes === 'number' && entry.s < minBytes) return -1;
  if (typeof maxBytes === 'number' && entry.s > maxBytes) return -1;
  if (typeof after === 'number' && entry.m < after) return -1;
  if (typeof before === 'number' && entry.m >= before) return -1;
  if (!terms || !terms.length) return 0;
  const nl = entry.nl || foldName(entry.n);
  let tier = 0;
  let pathOnly = 0;
  let dirParts = null;
  for (const t of terms) {
    let k = matchTier(nl, t);
    if (k < 0) {
      if (!opt || !opt.pathTerms) return -1;
      if (!dirParts) dirParts = foldName(entry.p.slice(0, entry.p.lastIndexOf('/'))).split('/');
      if (!dirParts.some((part) => part.includes(t))) return -1;
      pathOnly++;
      k = PATH_TIER;
    }
    if (k > tier) tier = k;
  }
  if (pathOnly && pathOnly >= terms.length) return -1;
  if (opt) opt.pt = pathOnly;
  return tier;
}

const byTierThenNewest = (a, b) => (a.tier - b.tier) || (b.e.m - a.e.m);

// Files, best first; and, when `q.dirs` asks for them on a plain name query,
// the folders whose own name holds every term — returned apart, as the
// Windows host does, so a folder never takes a file's place in the list.
function queryEntries(entries, q) {
  return queryIndex(entries, q).items;
}

function queryIndex(entries, q) {
  const terms = (q.terms || []).map((t) => foldName(t)).filter(Boolean);
  const exts = Array.isArray(q.exts) && q.exts.length
    ? q.exts.map((e) => String(e).toLowerCase().replace(/^\./, ''))
    : null;
  const max = Math.max(1, Math.min(500, q.max || 60));
  const dirMax = Math.max(0, Math.min(50, q.dirs || 0));
  const plain = terms.length && !exts && q.after == null && q.before == null && q.minBytes == null && q.maxBytes == null;
  const opt = { pathTerms: q.pathTerms === true && terms.length >= 2, pt: 0 };
  // Bounded best-of over the WHOLE index, trimmed as it grows: stopping at
  // the first `max` hits handed the ranker whatever the walk met first.
  let best = [];
  let bestDirs = [];
  for (const e of entries) {
    if (e.d) {
      if (!dirMax || !plain || e.x) continue;
      const tier = entryTier(e, terms, null, undefined, undefined, undefined, undefined);
      if (tier < 0) continue;
      bestDirs.push({ tier, e, pt: 0 });
      if (bestDirs.length > dirMax * 4) { bestDirs.sort(byTierThenNewest); bestDirs = bestDirs.slice(0, dirMax); }
      continue;
    }
    opt.pt = 0;
    const tier = entryTier(e, terms, exts, q.after, q.before, q.minBytes, q.maxBytes, opt);
    if (tier < 0) continue;
    best.push({ tier, e, pt: opt.pt });
    if (best.length > max * 4) { best.sort(byTierThenNewest); best = best.slice(0, max); }
  }
  best.sort(byTierThenNewest);
  bestDirs.sort(byTierThenNewest);
  return {
    items: best.slice(0, max).map(({ e, pt }) => (pt ? { p: e.p, n: e.n, s: e.s, m: e.m, pt } : { p: e.p, n: e.n, s: e.s, m: e.m })),
    dirs: bestDirs.slice(0, dirMax).map(({ e }) => ({ p: e.p, n: e.n, s: 0, m: e.m })),
  };
}

module.exports = {
  foldName, matchTier, PATH_TIER, entryTier, byTierThenNewest, queryEntries, queryIndex,
};
