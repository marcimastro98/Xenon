'use strict';
// The slow half of a search, Windows Search: asked once per query and kept for a few seconds,
// so the follow-up collects the answer instead of asking again, and its rows.

const path = require('node:path');
const SearchQuery = require('../search-query.js');
const { WDS_MAX, CATALOG_STASH_MS, CATALOG_STASH_MAX } = require('./search-limits.js');

function makeCatalog({ hostRequest, catalogStash }) {
  function catalogKey(q) {
    return JSON.stringify([q.terms, SearchQuery.effectiveExts(q), q.after, q.before, q.minBytes, q.maxBytes]);
  }

  function startCatalog(q) {
    const key = catalogKey(q);
    const now = Date.now();
    const hit = catalogStash.get(key);
    if (hit && now - hit.at < CATALOG_STASH_MS) return hit.promise;
    const content = q.terms.length > 0;
    const promise = hostRequest({
      terms: q.terms, exts: SearchQuery.effectiveExts(q),
      after: q.after, before: q.before, minBytes: q.minBytes, maxBytes: q.maxBytes,
      content, max: WDS_MAX,
    }).then((items) => ({ items, state: 'ok' }))
      .catch((e) => {
        const msg = String(e && e.message);
        const state = /wds_unsupported/.test(msg) ? 'unsupported'
          : /wds_unavailable/.test(msg) ? 'unavailable'
            : /superseded/.test(msg) ? 'superseded' : 'error';
        return { items: [], state };
      });
    catalogStash.set(key, { at: now, promise });
    for (const [k, v] of catalogStash) {
      if (catalogStash.size <= CATALOG_STASH_MAX && now - v.at < CATALOG_STASH_MS) break;
      catalogStash.delete(k);
    }
    return promise;
  }

  function catalogItems(wdsOut, content) {
    const out = [];
    for (const it of (wdsOut && wdsOut.items) || []) {
      if (!it || typeof it.p !== 'string') continue;
      out.push({
        path: it.p, name: it.n || path.basename(it.p), dir: path.dirname(it.p),
        size: it.s || 0, mtime: it.m || 0,
        // The catalog can match on indexed CONTENT: rows whose name misses the
        // terms survive ranking via the content floor only when content search
        // was actually on.
        contentHit: content,
        source: 'catalog',
      });
    }
    return out;
  }

  return { startCatalog, catalogItems };
}

module.exports = { makeCatalog };
