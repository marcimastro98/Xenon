// The still pictures of the cameras of the house: one from UniFi Protect, one from Home
// Assistant.

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /api/unifiprotect/snapshot/*': async (_req, res, { reqPath }, { deckUnifi, readHubSettings }) => {
    // Loopback JPEG proxy: fetch one camera's snapshot from the console (password
    // stays server-side) and stream it back. The id is strictly validated before
    // it reaches the console path. no-store so each ?ts= pull is a fresh frame.
    // decodeURIComponent must stay INSIDE the try: a malformed escape (e.g. a bare
    // "%") throws URIError, and an unhandled throw out of this async handler would
    // crash the process (Node's default unhandledRejection = throw). The other
    // decode routes (/api/timers, /uploads) guard their decode the same way.
    try {
      const id = decodeURIComponent(reqPath.slice('/api/unifiprotect/snapshot/'.length));
      if (!/^[A-Za-z0-9]{4,64}$/.test(id)) { res.writeHead(400); res.end('bad camera id'); return; }
      const s = (await readHubSettings().catch(() => null)) || {};
      const u = (s && s.unifi) || {};
      if (!(u.host && u.username && u.password)) { res.writeHead(404); res.end(); return; }
      const jpeg = await deckUnifi.snapshot(id);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': jpeg.length });
      res.end(jpeg);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('snapshot failed');
    }
  },

  'GET /api/ha/camera/snapshot/*': async (_req, res, { reqPath }, { deckHa }) => {
    // Loopback JPEG proxy for a Home Assistant camera: fetch the current frame from
    // HA's camera_proxy (token stays server-side) and stream it back. The entity id
    // is strictly validated before it reaches the HA path. decodeURIComponent stays
    // INSIDE the try — a malformed "%" escape throws URIError, and an unhandled
    // throw from this async handler would crash the process (mirrors the UniFi
    // snapshot proxy above). no-store so each ?ts= pull is a fresh frame.
    try {
      const entity = decodeURIComponent(reqPath.slice('/api/ha/camera/snapshot/'.length));
      if (!/^camera\.[a-z0-9_]+$/.test(entity)) { res.writeHead(400); res.end('bad camera id'); return; }
      // No settings pre-read here: cameraSnapshot reads the config itself and
      // throws ha_not_configured — a second full readHubSettings on this per-frame
      // hot path (default 1.5s per camera) would double the parse+normalize cost.
      const jpeg = await deckHa.cameraSnapshot(entity);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': jpeg.length });
      res.end(jpeg);
    } catch (e) {
      if (e && e.message === 'ha_not_configured') { res.writeHead(404); res.end(); return; }
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('snapshot failed');
    }
  },
};

module.exports = { branches };
