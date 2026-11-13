// The pictures SDK widgets fetch through the server (map tiles, covers): a small cache, and a
// limit per package on how many may be fetched at once.

// ── SDK map-tile cache (GET /sdk/tile/<pkg>?u=…) ────────────────────────────
// A radar/map widget needs many small image tiles from a tile server — over the
// postMessage fetch bridge that means base64 round-trips at ~1 req/s, unusable
// for a slippy map. Instead the widget points an <img>/Leaflet layer straight at
// the SAME-ORIGIN /sdk/tile route, which the CSP already allows (`img-src
// 'self'`) with NO relaxation. The route re-uses the exact proxy trust boundary
// (allowlisted + granted host, guardedLookup SSRF block, size cap) and adds a
// bounded LRU + coalescing so panning a map doesn't re-hammer the origin. Only
// image/* responses are cached/served — the tile route is images, not a second
// data channel. Secrets are NEVER injected here (that's the fetch bridge only).
const SDK_TILE_CACHE_MAX = 256;         // ~a few screenfuls of tiles
const SDK_TILE_TTL_MS = 10 * 60 * 1000; // radar frames refresh on the order of minutes
const _sdkTileCache = new Map();        // url → { at, contentType, buffer }
const _sdkTileInflight = new Map();     // url → Promise (coalesce concurrent misses)
function sdkTileCacheGet(url) {
  const hit = _sdkTileCache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > SDK_TILE_TTL_MS) { _sdkTileCache.delete(url); return null; }
  // LRU touch: re-insert so eviction drops the least-recently used.
  _sdkTileCache.delete(url);
  _sdkTileCache.set(url, hit);
  return hit;
}
function sdkTileCachePut(url, contentType, buffer) {
  _sdkTileCache.set(url, { at: Date.now(), contentType, buffer });
  while (_sdkTileCache.size > SDK_TILE_CACHE_MAX) {
    const oldest = _sdkTileCache.keys().next().value;
    if (oldest === undefined) break;
    _sdkTileCache.delete(oldest);
  }
}
// Per-package tile gate — a miss costs an outbound fetch, so bound both live
// concurrency and a rolling rate so a widget can't turn the tile route into a
// scraper. Cache HITS are free and never gated. Returns a release fn, or null
// when over budget (→ 429). Maps are bounded by the ≤32-package install cap.
const _sdkTileConc = new Map();   // pkgId → inflight miss count
const _sdkTileRate = new Map();   // pkgId → { windowStart, count }
function sdkTileGate(pkgId) {
  const conc = _sdkTileConc.get(pkgId) || 0;
  if (conc >= 6) return null;
  const now = Date.now();
  let r = _sdkTileRate.get(pkgId);
  if (!r || now - r.windowStart > 10000) { r = { windowStart: now, count: 0 }; _sdkTileRate.set(pkgId, r); }
  if (r.count >= 120) return null;
  r.count++;
  _sdkTileConc.set(pkgId, conc + 1);
  return () => { _sdkTileConc.set(pkgId, Math.max(0, (_sdkTileConc.get(pkgId) || 1) - 1)); };
}

module.exports = {
  SDK_TILE_CACHE_MAX, SDK_TILE_TTL_MS, _sdkTileCache, _sdkTileInflight, sdkTileCacheGet,
  sdkTileCachePut, _sdkTileConc, _sdkTileRate, sdkTileGate,
};
