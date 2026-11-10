'use strict';
// Anonymous star-rating proxy. The dashboard never talks to the hub directly:
//   GET  /api/community/ratings?ids=a,b → aggregate stars per entry
// This local server validates shape and forwards to the author-owned hub (fixed
// HUB_BASE, never user-configurable). Voting itself is rating-votes.js.
//
// It follows the community-catalog proxy discipline: https-only, timeout, bounded
// body, no redirects, no-throw result objects, TTL cache + in-flight dedup (a cache
// miss triggers an outbound fetch, which is why the route sits in
// CSRF_MUTATION_PATHS).

const https = require('https');
const { HUB_BASE } = require('./supporter-redeem');
const { armDeadline } = require('./net-guard');

const FETCH_TIMEOUT_MS = 8000;
// `timeout` is an idle timeout only; a hub that trickles bytes would hold the
// request, and the single-flight read waiting on it, open forever. This bounds
// the whole request (net-guard.armDeadline).
const FETCH_DEADLINE_MS = 15000;
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
    armDeadline(req, FETCH_DEADLINE_MS);
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

async function fetchRatings({ ids }) {
  const clean = cleanIds(ids);
  if (!clean.length) return { ok: true, ratings: {} };
  const key = clean.slice().sort().join(',');
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < RATINGS_TTL_MS) return hit.data;
  const pending = _inFlight.get(key);
  if (pending) return pending;
  const run = (async () => {
    const out = await _transport(HUB_BASE + '/ratings?ids=' + encodeURIComponent(clean.join(',')));
    const data = (out && out.ok && out.ratings && typeof out.ratings === 'object')
      ? { ok: true, minDisplayCount: Number(out.minDisplayCount) || 5, ratings: out.ratings }
      : { ok: false, error: 'network' };
    if (data.ok) {
      if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
      _cache.set(key, { at: Date.now(), data });
    }
    return data;
  })();
  _inFlight.set(key, run);
  run.finally(() => _inFlight.delete(key));
  return run;
}

// A vote just changed this entry's numbers: drop every set containing it.
function forget(entryId) {
  for (const [key, hit] of _cache) {
    if (hit.data && hit.data.ratings && key.split(',').includes(entryId)) _cache.delete(key);
  }
}

module.exports = {
  fetchRatings,
  forget,
  cleanIds,
  _setTransport(fn) { _transport = fn || requestJson; },
  _resetCache() { _cache.clear(); _inFlight.clear(); },
};
