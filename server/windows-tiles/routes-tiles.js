// What the engine does for the second screen, slideshow, browser and windows tiles: what the
// second screen needs, its driver and display, the pictures of a slideshow and one uploaded,
// the state of the ad filter, a favourite app started, and a tile taking what the assistant
// asked to play.

const { readBody, readBodyBuffer } = require('../http/read-body.js');
const remoteActions = require('../remote-actions.js');
const { hub } = require('../settings/current.js');
const { readDeckStore } = require('../deck/store-read.js');
const browserAdblock = require('../embedded-browser-adblock.js');
const { DATA_DIR } = require('../engine/paths.js');
const {
  SLIDESHOW_ASSET_MAX_BYTES, SLIDESHOW_ASSET_MIME_BY_EXT,
} = require('../http/upload-limits.js');
const { parseMultipartBackground } = require('../http/multipart-upload.js');
const path = require('node:path');
const fs = require('node:fs');
const { UPLOADS_DIR } = require('../engine/uploads-dir.js');
const slideshowFolder = require('../slideshow-folder.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'POST /windows/launch': async (req, res, { json, err500, isRemote }, { deckRegistry }) => {
    // Launch a favorited app that isn't currently open, by its stored exe path.
    // The path came from the server's own window enumeration, but it is re-validated
    // through the SAME allowlisted openApp runner the Deck uses (exe/.lnk only +
    // existence check) before anything spawns — never trusted blindly.
    try {
      const { path: appPath } = JSON.parse(await readBody(req));
      if (!appPath || typeof appPath !== 'string') {
        res.writeHead(400); res.end('Missing path'); return;
      }
      // From a paired phone, only an app the user already chose: a favourite
      // or a Deck key's app. Otherwise a file sent from the phone could be
      // started right after it lands.
      if (isRemote && !remoteActions.remoteMayLaunch(appPath, hub.settings && hub.settings.appFavorites, await readDeckStore())) {
        json({ ok: false, error: 'needs_pc' }); return;
      }
      json(await deckRegistry.run({ type: 'openApp', path: appPath }));
    } catch (e) { err500(e.message); }
  },

  'GET /embedded-browser/adblock': async (_req, _res, { json }, { embeddedBrowser }) => {
    // Ad-blocker status for Settings → Browser: whether the extension is installed,
    // whether the user has it enabled, and whether a download is in flight.
    json({
      available: embeddedBrowser.available(),
      installed: browserAdblock.isInstalled(DATA_DIR),
      enabled: !!(hub.settings && hub.settings.browserAdblock),
      busy: browserAdblock.isBusy(),
    });
  },

  'POST /slideshow-asset': async (req, res, { json }, { SLIDESHOW_ASSET_EXT_BY_MIME }) => {
    // Slideshow image upload. Mirrors /tile-asset: keeps every file (a slideshow is
    // many pictures), a server-generated `slideshow-*` name, orphans reclaimed by
    // cleanupUnreferencedSlideshowAssets() on settings save. This is what lets a
    // slideshow hold far more images than the old inline-base64 model — they live on
    // disk, not in the settings blob.
    try {
      const body = await readBodyBuffer(req, SLIDESHOW_ASSET_MAX_BYTES);
      const file = parseMultipartBackground(req, body, 'asset');
      const extFromName = path.extname(file.originalName).toLowerCase();
      const ext = SLIDESHOW_ASSET_MIME_BY_EXT.has(extFromName) ? extFromName : SLIDESHOW_ASSET_EXT_BY_MIME.get(file.contentType);
      if (!ext || !SLIDESHOW_ASSET_MIME_BY_EXT.has(ext)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unsupported file type' }));
        return;
      }
      const expectedType = SLIDESHOW_ASSET_MIME_BY_EXT.get(ext);
      if (file.contentType && file.contentType !== 'application/octet-stream' && file.contentType !== expectedType) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File type mismatch' }));
        return;
      }
      await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
      const safeName = `slideshow-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`;
      await fs.promises.writeFile(path.join(UPLOADS_DIR, safeName), file.data);
      json({ ok: true, url: `/uploads/${safeName}`, name: file.originalName, type: expectedType, size: file.data.length });
    } catch (e) {
      if (e.code === 'PAYLOAD_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
  },

  'GET /slideshow/folder': async (_req, _res, { json, err500, urlObj }, { getSlideshowDir }) => {
    // How many images the configured slideshow folder holds (plus why it can't be
    // read, when it can't). The folder comes from the SETTINGS, never from the
    // query — the only thing a caller may influence is `?refresh=1`, which skips
    // the 30s enumeration cache so the settings pane reflects a folder the user
    // just filled. Read-only, so it stays out of CSRF_MUTATION_PATHS.
    try {
      const dir = await getSlideshowDir();
      const refresh = urlObj.searchParams.get('refresh') === '1';
      json(await slideshowFolder.listFolder(dir, { refresh }));
    } catch (e) {
      err500(e.message);
    }
  },

  'POST /tiles/play-claim': async (req, _res, { json }, { tilePlay }) => {
    // A surface on this PC with the tile takes what Bit asked to play
    // (tile-play.js); the first claim wins. In CSRF_MUTATION_PATHS, denied to
    // paired devices in remote-access.js.
    try {
      const body = JSON.parse(await readBody(req, 4 * 1024) || '{}');
      json({ ok: tilePlay.claim(body && body.nonce) });
    } catch { json({ ok: false }); }
  },

  'GET /second-screen/requirements': async (_req, _res, { json, err500 }, { screenCapture, secondScreen }) => {
    try {
      const r = await secondScreen.requirements();
      // The tile also needs the native helper (the GDI capture host); fold its
      // presence into the same payload so the client decides in one round-trip.
      r.captureAvailable = screenCapture.available();
      json(r);
    } catch (e) { err500(e.message); }
  },

  'POST /second-screen/install': async (req, _res, { json, err500 }, { secondScreen }) => {
    try {
      await readBody(req);
      json(await secondScreen.installDriver());
    } catch (e) { err500(e.message); }
  },

  'POST /second-screen/create-display': async (req, _res, { json, err500 }, { secondScreen }) => {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await secondScreen.createDisplay(body && body.mode));
    } catch (e) { err500(e.message); }
  },

  'POST /second-screen/apply-resolution': async (req, _res, { json, err500 }, { applySecondScreenMode }) => {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await applySecondScreenMode((body && body.mode) || {}, { soft: !!(body && body.soft) }));
    } catch (e) { err500(e.message); }
  },

  'POST /second-screen/remove-display': async (req, _res, { json, err500 }, { secondScreen }) => {
    try {
      await readBody(req);
      json(await secondScreen.removeDisplay());
    } catch (e) { err500(e.message); }
  },

  'GET /slideshow/file': async (req, res, { err500, urlObj }, { getSlideshowDir }) => {
    // Stream the Nth image of the configured folder. The index is the ONLY thing
    // the caller supplies; slideshow-folder.js resolves it against its own
    // enumeration of the folder named in the settings, so no caller-supplied path
    // ever reaches an fs call. Out of range or vanished → 404, because a folder
    // legitimately changes while a slideshow is running.
    try {
      const dir = await getSlideshowDir();
      const hit = await slideshowFolder.resolveFile(dir, urlObj.searchParams.get('i'));
      if (!hit) { res.writeHead(404); res.end(); return; }
      const stat = await fs.promises.stat(hit.abs);
      if (!stat.isFile()) { res.writeHead(404); res.end(); return; }
      // The upload path caps each image; a folder is not curated by us, so cap it
      // here too. 413 rather than 404 so the tile can tell "too big" from "gone" —
      // both make it step to the next image, but only one is worth explaining.
      if (stat.size > slideshowFolder.MAX_BYTES) { res.writeHead(413); res.end(); return; }
      // Not `immutable` like /uploads/: an uploaded asset has a unique generated
      // name, but index N of a folder means a different file the moment the user
      // adds or deletes one. Revalidate against mtime+size instead.
      const etag = `"${stat.size}-${Math.round(stat.mtimeMs)}"`;
      // Honor the revalidation the ETag invites: without this, every playlist
      // wrap re-streamed unchanged bodies (up to 20 MB each) forever.
      if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
      res.writeHead(200, {
        'Content-Type': hit.mime,
        'Content-Length': String(stat.size),
        'Cache-Control': 'private, no-cache',
        'ETag': etag,
      });
      // pipeline, not pipe: a client that goes away must close the file too,
      // or each aborted load leaks a descriptor (and on Windows a lock).
      require('stream').pipeline(fs.createReadStream(hit.abs), res, () => {});
    } catch (e) {
      if (e.code === 'ENOENT') { res.writeHead(404); res.end(); }
      else err500(e.message);
    }
  },
};

module.exports = { branches };
