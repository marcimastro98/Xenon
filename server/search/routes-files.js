// What the engine answers when files are searched: the results, the recent ones, a thumbnail
// and an icon, opening and revealing a file, and the state of the index.

const fs = require('node:fs');
const { readBody } = require('../http/read-body.js');
const { resolveStoreAppIcon, resolveAppIcons, appIconCache } = require('../programs/app-icons.js');
const { macDiskAccess } = require('./mac-disk-access.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /search': async (_req, _res, { json, err500, urlObj }, { fileSearch }) => {
    // Local file search (Spotlight). Read-only compute over the Windows Search
    // catalog + the crawler index — no mutation, no outbound network, so it
    // stays out of CSRF_MUTATION_PATHS (and is NEVER a JSONP candidate: the
    // results carry the user's file names). Result paths travel OUT as display
    // text only; acting on a result goes through the opaque id below.
    try {
      // Long enough for a pasted path; filesearch cuts a typed query to 200.
      const q = String(urlObj.searchParams.get('q') || '').slice(0, 1024);
      let disable;
      try {
        const rawDisable = urlObj.searchParams.get('disable');
        disable = rawDisable ? JSON.parse(rawDisable) : undefined;
        if (disable && typeof disable !== 'object') disable = undefined;
      } catch { disable = undefined; }
      // The dashboard is answered from the index at once (Windows Search gets
      // a short head start) and collects the catalog's rows with ?catalog=1.
      json(urlObj.searchParams.get('catalog') === '1'
        ? await fileSearch.catalog(q, { disable })
        : await fileSearch.search(q, { disable, catalogWaitMs: 300 }));
    } catch (e) { err500(e.message); }
  },

  'GET /search/recent': async (_req, _res, { json, err500 }, { fileSearch }) => {
    // What the empty search shows: files and folders recently opened from
    // Xenon, re-checked to exist, each with an opaque id. Read-only, from the
    // usage log in DATA_DIR. The Search TILE asks only when its setting is on.
    try { json(await fileSearch.recent({ max: 8 })); } catch (e) { err500(e.message); }
  },

  'GET /search/thumb': async (req, res, { err500, urlObj }, { fileSearch }) => {
    // The preview of an image result, by opaque id. Raster types only, bounded,
    // served as the image it is with nosniff and a sandboxing CSP, never from a
    // cross-site request (the transfer thumbnail's shape).
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
      res.writeHead(403); res.end(); return;
    }
    try {
      const target = await fileSearch.thumbTarget(urlObj.searchParams.get('id'));
      if (!target) { res.writeHead(404); res.end(); return; }
      const body = await fs.promises.readFile(target.path);
      const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif' };
      res.writeHead(200, {
        'Content-Type': MIME[target.ext] || 'application/octet-stream',
        'Content-Length': String(body.length),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, max-age=300',
      });
      res.end(body);
    } catch (e) {
      if (e && e.code === 'ENOENT') { res.writeHead(404); res.end(); } else err500(e.message);
    }
  },

  'POST /search/open': async (req, _res, { json, err500 }, { fileSearch }) => {
    // Open one search result. The body carries an opaque id minted by the
    // search above — never a path; filesearch.js resolves it against its own
    // bounded cache and re-applies the Deck openFile rules (executable/script
    // extensions refuse with revealable:true). In CSRF_MUTATION_PATHS.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await fileSearch.open(body.id));
    } catch (e) { err500(e.message); }
  },

  'POST /search/reveal': async (req, _res, { json, err500 }, { fileSearch }) => {
    // Show one search result in Explorer (select-in-folder) — the safe path
    // for results openFile refuses. Same opaque-id contract as /search/open.
    // In CSRF_MUTATION_PATHS.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await fileSearch.reveal(body.id));
    } catch (e) { err500(e.message); }
  },

  'GET /search/icon': async (_req, _res, { json, urlObj }, { fileSearch }) => {
    // The real logo for a search result: app results get the Store tile logo
    // (Spotify, WhatsApp) or their Start-Menu shortcut's icon; exe/lnk file
    // results get their embedded icon. Read-only: takes the opaque result id
    // — never a path, per the search invariant — and reuses the Deck's cached
    // extractors. A null extraction is evicted from the cache so a transient
    // failure retries on the next request instead of pinning "no icon".
    try {
      const target = fileSearch.iconTarget(urlObj.searchParams.get('id'));
      let icon = null;
      let extractPath = null;
      if (target && target.app) {
        if (target.kind === 'store') icon = await resolveStoreAppIcon(target.target);
        // A Start Menu shortcut has an embedded icon to extract; a macOS bundle
        // or a .desktop entry does not go through the Windows extractor.
        else if (target.kind === 'lnk') extractPath = target.target;
      } else if (target && (target.ext === 'exe' || target.ext === 'lnk')) {
        extractPath = target.path;
      }
      if (extractPath) {
        const icons = await resolveAppIcons([extractPath]);
        icon = icons[0] || null;
        if (!icon) appIconCache.delete(extractPath.toLowerCase());
      }
      json({ ok: !!icon, icon: icon || null });
    } catch { json({ ok: false, icon: null }); }
  },

  'GET /index/status': async (_req, _res, { json, err500 }, { livingIndex }) => {
    // Living Index state for Settings + the disk widget: on/off, building
    // progress, file count, resident RAM, roots. Read-only.
    //
    // `fdaBlocked` rides along because an index that is off for a REASON and
    // one that is off because nobody turned it on look identical from here,
    // and on macOS the reason is the whole story: the permission went away by
    // itself when Xenon updated.
    try {
      json({
        ...(await livingIndex.stats()),
        fdaBlocked: process.platform === 'darwin' && !macDiskAccess.granted && macDiskAccess.blockedRoots.length > 0,
        fdaRoots: macDiskAccess.blockedRoots.slice(0, 8),
      });
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
