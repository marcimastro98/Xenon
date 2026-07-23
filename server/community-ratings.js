'use strict';
// Anonymous star-rating proxy. The dashboard never talks to the hub directly:
//   GET  /api/community/ratings?ids=a,b[&mine=1] → aggregate stars per entry
//   POST /api/community/rate {entryId, stars}    → set THIS install's vote
// This local server validates shape, attaches the voter id itself (the browser
// never supplies it — same rule as the redeem proxy) and forwards to the
// author-owned hub (fixed HUB_BASE, never user-configurable).
//
// The voter id is the RATINGS-scoped hash of the install id, not the install id
// (supporter-redeem.getScopedId). A vote and a supporter activation must not
// carry the same value, or the hub could tell which ratings a named supporter
// cast; the raw id stays on this machine.
//
// Both halves follow the community-catalog proxy discipline: https-only,
// timeout, bounded body, no redirects, no-throw result objects, TTL cache +
// in-flight dedup on the read path (a cache miss triggers an outbound fetch,
// which is why both routes sit in CSRF_MUTATION_PATHS).

const https = require('https');
const { getScopedId, SCOPE_RATINGS, HUB_BASE } = require('./supporter-redeem');

const FETCH_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const ENTRY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;
const MAX_IDS = 100;
const RATINGS_TTL_MS = 5 * 60 * 1000;

// ── Bounded outbound helpers (mirror supporter-redeem's postJson) ───────────
function requestJson(url, { method = 'GET', body = null } = {}) {
  return new Promise((resolve) => {
    if (!/^https:\/\//i.test(url)) return resolve({ ok: false, error: 'network' });
    const payload = body == null ? null : JSON.stringify(body);
    let req;
    try {
      req = https.request(url, {
        method,
        timeout: FETCH_TIMEOUT_MS,
        headers: payload == null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, onResponse);
    } catch {
      return resolve({ ok: false, error: 'network' });
    }
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ ok: false, error: 'network' }));
    req.end(payload == null ? undefined : payload);

    function onResponse(res) {
      if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); return resolve({ ok: false, error: 'network' }); }
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) { req.destroy(new Error('body too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve({ ok: false, error: 'network' }); }
      });
      res.on('error', () => resolve({ ok: false, error: 'network' }));
    }
  });
}

let _transport = requestJson; // swappable for tests

// ── Read path: TTL cache + in-flight dedup keyed on the id set ──────────────
const _cache = new Map();     // key → { at, data }
const _inFlight = new Map();  // key → Promise
const CACHE_MAX = 20;

function cleanIds(raw) {
  const seen = new Set();
  const out = [];
  for (const part of String(raw || '').split(',')) {
    const id = part.trim();
    if (!ENTRY_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_IDS) break;
  }
  return out;
}

async function fetchRatings({ ids, mine, dataDir }) {
  const clean = cleanIds(ids);
  if (!clean.length) return { ok: true, ratings: {} };
  // A personalized read (mine=1) bypasses the shared cache: the vote control
  // must reflect a just-cast vote immediately, and its answer is per-install.
  const wantMine = mine === true;
  const key = clean.slice().sort().join(',');
  const now = Date.now();
  if (!wantMine) {
    const hit = _cache.get(key);
    if (hit && now - hit.at < RATINGS_TTL_MS) return hit.data;
    const pending = _inFlight.get(key);
    if (pending) return pending;
  }
  const run = (async () => {
    let url = HUB_BASE + '/ratings?ids=' + encodeURIComponent(clean.join(','));
    if (wantMine) url += '&scopedId=' + encodeURIComponent(await getScopedId(dataDir, SCOPE_RATINGS));
    const out = await _transport(url);
    const data = (out && out.ok && out.ratings && typeof out.ratings === 'object')
      ? { ok: true, minDisplayCount: Number(out.minDisplayCount) || 3, ratings: out.ratings }
      : { ok: false, error: 'network' };
    if (!wantMine && data.ok) {
      if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
      _cache.set(key, { at: Date.now(), data });
    }
    return data;
  })();
  if (!wantMine) {
    _inFlight.set(key, run);
    run.finally(() => _inFlight.delete(key));
  }
  return run;
}

// ── Write path ───────────────────────────────────────────────────────────────
async function submitRating({ entryId, stars, dataDir }) {
  const id = String(entryId || '');
  const n = Number(stars);
  if (!ENTRY_ID_RE.test(id) || !Number.isInteger(n) || n < 1 || n > 5) {
    return { ok: false, error: 'bad_request' };
  }
  const scopedId = await getScopedId(dataDir, SCOPE_RATINGS);
  const out = await _transport(HUB_BASE + '/ratings', { method: 'POST', body: { entryId: id, scopedId, stars: n } });
  if (out && out.ok) {
    // The shared aggregate cache now under-counts this entry — drop every set
    // containing it so the next read reflects the vote.
    for (const [key, hit] of _cache) {
      if (hit.data && hit.data.ratings && key.split(',').includes(id)) _cache.delete(key);
    }
    return { ok: true };
  }
  const error = out && ['bad_request', 'bad_entry', 'rate_limited', 'catalog_unavailable'].includes(out.error)
    ? out.error : 'network';
  return { ok: false, error };
}

module.exports = {
  fetchRatings,
  submitRating,
  cleanIds,
  _setTransport(fn) { _transport = fn || requestJson; },
  _resetCache() { _cache.clear(); _inFlight.clear(); },
};
