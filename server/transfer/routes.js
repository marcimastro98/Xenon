// What the engine answers about files sent between the phone and the PC: the list, a thumbnail,
// opening, revealing and deleting one, undoing a delete, and the settings with the folder they
// land in.

const fileTransferLib = require('../file-transfer.js');
const fs = require('node:fs');
const { TRANSFER_THUMB_MAX } = require('./limits.js');
const { readBody } = require('../http/read-body.js');
const { isBlockedOpenPath } = require('../actions/registry.js');
const { openExternalPath } = require('../deck/open-external-path.js');
const { revealInFileManager } = require('../files/reveal-in-file-manager.js');
const { serveFileRange } = require('../http-range.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /api/transfer/list': async (_req, _res, { json, err500, isRemote }, { transferState }) => {
    // A read. Deliberately NOT in CSRF_MUTATION_PATHS: listing changes nothing,
    // and a GET listed there is refused on the paired-device door, which would
    // leave the phone with a widget that can send but never show anything.
    try { json({ ok: true, ...transferState(!isRemote) }); } catch (e) { err500(e.message); }
  },

  'GET /api/transfer/thumb': async (req, res, { err500, urlObj }, { fileTransfer }) => {
    // Preview for the list. Only the raster types a browser really decodes —
    // nothing is generated or transcoded here, because that would be a
    // dependency. A HEIC straight off an iPhone answers 404, and the client
    // turns that into an extension chip rather than a broken image.
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
      res.writeHead(403); res.end(); return;
    }
    try {
      const rec = fileTransfer.get(urlObj.searchParams.get('id') || '');
      if (!rec || !fileTransferLib.isThumbable(rec.ext)) { res.writeHead(404); res.end(); return; }
      const abs = fileTransfer.absOf(rec);
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile() || stat.size > TRANSFER_THUMB_MAX) { res.writeHead(404); res.end(); return; }
      const body = await fs.promises.readFile(abs);
      res.writeHead(200, {
        'Content-Type': fileTransferLib.downloadMimeFor(rec.ext),
        'Content-Length': String(body.length),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, max-age=300',
      });
      res.end(body);
    } catch (e) {
      if (e.code === 'ENOENT') { res.writeHead(404); res.end(); }
      else err500(e.message);
    }
  },

  'POST /api/transfer/open': async (req, _res, { json }, { fileTransfer }) => {
    // Open a received file on the PC. Same contract as /search/open: an opaque
    // id in, the Deck registry's blocklist re-applied, and an executable
    // refused with revealable:true so the UI can offer the one action that
    // runs nothing. In CSRF_MUTATION_PATHS.
    try {
      const body = JSON.parse(await readBody(req, 4096) || '{}');
      const rec = fileTransfer.get(body.id);
      if (!rec) { json({ ok: false, error: 'unknown_id' }); return; }
      // Prefer the copy in the user's own folder: it carries the real filename,
      // which is what their apps and their recent-files lists will show.
      const target = rec.delivered || fileTransfer.absOf(rec);
      if (isBlockedOpenPath(target)) { json({ ok: false, error: 'blocked_ext', revealable: true }); return; }
      try { await fs.promises.stat(target); } catch { json({ ok: false, error: 'not_found' }); return; }
      await openExternalPath(target);
      json({ ok: true });
    } catch (e) { json({ ok: false, error: 'open_failed', detail: e.message }); }
  },

  'POST /api/transfer/reveal': async (req, _res, { json }, { fileTransfer }) => {
    // Show it in the file manager. The one path an executable may take, since
    // revealing something runs nothing. In CSRF_MUTATION_PATHS.
    try {
      const body = JSON.parse(await readBody(req, 4096) || '{}');
      const rec = fileTransfer.get(body.id);
      if (!rec) { json({ ok: false, error: 'unknown_id' }); return; }
      const target = rec.delivered || fileTransfer.absOf(rec);
      try { await fs.promises.stat(target); } catch { json({ ok: false, error: 'not_found' }); return; }
      revealInFileManager(target);
      json({ ok: true });
    } catch (e) { json({ ok: false, error: 'reveal_failed', detail: e.message }); }
  },

  'POST /api/transfer/delete': async (req, _res, { json, err500 }, { TRANSFER_UNDO_MS, broadcastTransfer, fileTransfer, holdForUndo }) => {
    // Removes XENON's copy. The file already delivered into the user's own
    // folder is deliberately left alone — this list is ours, that folder is
    // theirs, and a "clear the list" that reached into Downloads would be the
    // last surprise this feature ever gave anyone. In CSRF_MUTATION_PATHS.
    try {
      const body = JSON.parse(await readBody(req, 4096) || '{}');
      // The blob outlives the record for a few seconds so the delete can be
      // taken back — "there is no way back" was half of what was reported. The
      // RECORD comes back here, not a boolean, and it carries this PC's paths:
      // only `ok` may travel to a phone.
      const rec = await fileTransfer.remove(body.id, { keepBlob: true });
      if (rec) holdForUndo(rec);
      broadcastTransfer();
      json({ ok: !!rec, undoMs: rec ? TRANSFER_UNDO_MS : 0 });
    } catch (e) { err500(e.message); }
  },

  'POST /api/transfer/undo': async (req, _res, { json, err500 }, { broadcastTransfer, undoTransferDelete }) => {
    // Put back a record deleted within the window. In CSRF_MUTATION_PATHS.
    try {
      const body = JSON.parse(await readBody(req, 4096) || '{}');
      const ok = await undoTransferDelete(String(body.id || ''));
      if (ok) broadcastTransfer();
      json({ ok });
    } catch (e) { err500(e.message); }
  },

  'GET /api/transfer/settings': async (_req, _res, { json, err500 }, { _captureHost, fileTransfer, transferInboxDir, transferSettings }) => {
    // Loopback-only (REMOTE_DENY), because the answer contains a real folder on
    // this PC. The phone gets what it actually needs — the size limit — from
    // /api/transfer/list, which every surface can read.
    try {
      const s = transferSettings();
      json({
        ok: true,
        ...s,
        inboxDir: transferInboxDir(),
        inboxDefault: fileTransferLib.defaultInboxDir({}),
        // The folder comes from the system dialog where there is one.
        canPick: _captureHost.has('pick_folder'),
        stats: fileTransfer.stats(),
      });
    } catch (e) { err500(e.message); }
  },

  'POST /api/transfer/settings/pick': async (_req, _res, { json, err500, isRemote }, { _captureHost, chooseTransferFolder, updateTransferSettings }) => {
    // The arrival folder from the system's folder dialog, on the PC where the
    // capture engine runs. Loopback-only and in CSRF_MUTATION_PATHS, like the
    // POST above; the dialog's answer is validated by the same validInboxDir.
    try {
      if (isRemote || !_captureHost.has('pick_folder')) { json({ ok: false, error: 'unavailable' }); return; }
      const r = await chooseTransferFolder();
      if (!r.ok || r.cancelled) { json(r); return; }
      json(await updateTransferSettings({ inboxDir: r.path }));
    } catch (e) { err500(e.message); }
  },

  'GET|HEAD /api/transfer/file': async (req, res, { err500, urlObj }, { fileTransfer }) => {
    // Serving a file the user received, to a phone that wants it.
    //
    // This is not an arbitrary-file-read primitive, and the reason is
    // structural rather than a check: the wire carries an OPAQUE ID, resolved
    // against a manifest this server minted, whose `file` field was generated
    // here and is re-asserted against its shape before path.join sees it.
    // There is no caller-supplied path component to contain — strictly
    // stronger than /deck/sound, from which it borrows the cross-site reject.
    //
    // NOT in CSRF_MUTATION_PATHS on purpose: it is a pure read AND the user
    // taps Download, which is a top-level navigation — the isTopLevelNav reject
    // above would refuse the very download that was just asked for.
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
      res.writeHead(403); res.end(); return;
    }
    try {
      const rec = fileTransfer.get(urlObj.searchParams.get('id') || '');
      if (!rec) { res.writeHead(404); res.end(); return; }
      const abs = fileTransfer.absOf(rec);
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile()) { res.writeHead(404); res.end(); return; }
      serveFileRange(req, res, abs, stat, {
        // From a closed server-side map keyed on the extension WE stored, never
        // the client's declared type. A phone needs the real media MIME or it
        // cannot offer "Save to Photos" at all; the types where a real MIME
        // could become script in our origin are forced to octet-stream there.
        'Content-Type': fileTransferLib.downloadMimeFor(rec.ext),
        // The primary guarantee that a received file never renders inline here.
        'Content-Disposition': fileTransferLib.contentDisposition(rec.name),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes',
      });
    } catch (e) {
      if (e.code === 'ENOENT') { res.writeHead(404); res.end(); }
      else err500(e.message);
    }
  },
};

module.exports = { branches };
