// The pictures the engine fetches for a widget so its frame can show them from the engine's own
// address: map tiles kept in memory, artwork kept on disk.

const { sdkFeatureEnabled, sdkGrantsFor } = require('./grants.js');
const sdkWidgets = require('../sdk-widgets.js');
const { sdkTileCacheGet, sdkTileGate } = require('./tile-cache.js');
const { sdkTileFetch } = require('./tile-fetch.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /sdk/tile/*|/sdk/asset/*': async (_req, res, { reqPath, urlObj }, { sdkAssets, sdkPackagesCached }) => {
    // Same-origin image proxy for map/radar tiles, and for widget artwork. The
    // widget points an <img>/Leaflet tile layer straight at this URL — allowed
    // by the widget CSP's `img-src 'self'` with NO relaxation — so a slippy map
    // paints at native speed instead of base64-ing every tile over the fetch
    // bridge at ~1 req/s. Same trust boundary as the fetch proxy (allowlisted +
    // user-GRANTED host, guardedLookup SSRF block, size cap) plus a bounded
    // cache + per-package gate. Read-only, images only, and secrets are NEVER
    // injected here.
    //
    // TWO PATHS, ONE DOOR. `/sdk/asset/` differs from `/sdk/tile/` in exactly
    // one respect: where the answer is kept. Tiles live in a small memory LRU,
    // because a radar frame is stale in minutes and worthless tomorrow; artwork
    // goes to disk, because an album cover is the same next week and re-fetching
    // it is the whole cost worth avoiding. Everything before that — the host
    // check, the SSRF guard, the redirect handling, the image-only rule, the
    // rate gate — is the same code on both, deliberately: a second route would
    // be a second copy of a security model to keep in step, and the day they
    // drift one of them is the weaker door.
    //
    // Asked for by a widget author caching album, game and video art, who had
    // hit the store's 16 KB per value / 256 KB total ceiling doing it in base64.
    try {
      if (!sdkFeatureEnabled()) { res.writeHead(404); res.end(); return; }
      const persist = reqPath.startsWith('/sdk/asset/');
      const prefix = persist ? '/sdk/asset/' : '/sdk/tile/';
      const pkgId = decodeURIComponent(reqPath.slice(prefix.length));
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(pkgId)) { res.writeHead(404); res.end(); return; }
      const scan = await sdkPackagesCached();
      const pkg = scan.packages.find(p => p.id === pkgId);
      if (!pkg) { res.writeHead(404); res.end(); return; }
      const grants = sdkGrantsFor(pkgId);
      // A user-filled slot can host a tile server too (a self-hosted map on the
      // LAN), so the same resolved hosts apply here as on the fetch proxy.
      const filled = sdkWidgets.resolveUserHosts(pkg, grants.userHosts);
      const v = sdkWidgets.validateProxyRequest(pkg, { url: urlObj.searchParams.get('u') || '', method: 'GET' }, filled.hosts);
      if (!v.ok) { res.writeHead(400); res.end(); return; }
      let host = '';
      try { host = new URL(v.url).hostname.toLowerCase().replace(/\.$/, ''); } catch { /* validated */ }
      if (!grants.hosts.includes(host) && !filled.hosts.includes(host)) { res.writeHead(403); res.end(); return; }
      const serve = (contentType, buffer, hit) => {
        res.writeHead(200, {
          'Content-Type': contentType,
          // A cover is worth keeping in the browser too; a radar frame is not.
          'Cache-Control': persist ? 'public, max-age=86400' : 'public, max-age=600',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'X-Content-Type-Options': 'nosniff',
          [persist ? 'X-Xenon-Asset' : 'X-Xenon-Tile']: hit ? 'hit' : 'miss',
        });
        res.end(buffer);
      };
      if (persist) {
        const hit = await sdkAssets.get(pkgId, v.url).catch(() => null);
        if (hit && hit.buffer) { serve(hit.contentType, hit.buffer, true); return; }
        // A failure remembered briefly, so a render loop does not re-ask a dead
        // url every frame. Short-lived on purpose: artwork 404s are usually a
        // CDN mid-rename, and an hour of blank tiles is punishment enough.
        if (hit && hit.negative) { res.writeHead(hit.status, { 'Cache-Control': 'no-store' }); res.end(); return; }
      } else {
        const cached = sdkTileCacheGet(v.url);
        if (cached) { serve(cached.contentType, cached.buffer, true); return; }
      }
      // Only a MISS is gated: a cache hit costs nothing outbound, and a widget
      // painting from its own cache must never be throttled. A miss on the
      // persistent path costs a fetch AND a file, so it needs the gate more than
      // a tile does, not less.
      const release = sdkTileGate(pkgId);
      if (!release) { res.writeHead(429); res.end(); return; }
      try {
        const tile = await sdkTileFetch(v.url, { memoryCache: !persist });
        if (persist) await sdkAssets.put(pkgId, v.url, tile.contentType, tile.buffer).catch(() => {});
        serve(tile.contentType, tile.buffer, false);
      } catch (e) {
        if (persist) {
          const st = Number(e && e.status);
          await sdkAssets.putNegative(pkgId, v.url, st >= 400 && st < 600 ? st : 502).catch(() => {});
        }
        throw e;
      } finally { release(); }
    } catch (e) {
      const st = e && Number(e.status);
      res.writeHead(st >= 400 && st < 600 ? st : 502); res.end();
    }
  },
};

module.exports = { branches };
