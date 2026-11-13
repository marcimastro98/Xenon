// Fetches one picture for an SDK widget through the guarded proxy; two widgets asking for the
// same picture share one download.

const sdkProxy = require('../sdk-proxy.js');
const { _sdkTileInflight, sdkTileCachePut } = require('./tile-cache.js');

// Fetch (or coalesce onto an in-flight fetch of) one tile through the hardened
// proxy. Resolves { contentType, buffer } for an image, or throws.
function sdkTileFetch(url, opts) {
  // `memoryCache: false` is the artwork path: it keeps its answer on disk, and
  // filling the small tile LRU with covers would evict the tiles a map is
  // actively panning through. Coalescing is shared either way — two widgets
  // asking for the same cover at once is exactly when it matters.
  const memoryCache = !(opts && opts.memoryCache === false);
  const inflight = _sdkTileInflight.get(url);
  if (inflight) return inflight;
  const p = (async () => {
    const r = await sdkProxy.proxyFetch({ url, method: 'GET', headers: {}, body: '' });
    const ct = String(r.contentType || '');
    if ((r.status || 0) >= 400 || !/^image\//i.test(ct)) { const e = new Error('not_a_tile'); e.status = r.status; throw e; }
    if (memoryCache) sdkTileCachePut(url, ct, r.buffer);
    return { contentType: ct, buffer: r.buffer };
  })().finally(() => { _sdkTileInflight.delete(url); });
  _sdkTileInflight.set(url, p);
  return p;
}

module.exports = { sdkTileFetch };
