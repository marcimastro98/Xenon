// What the engine answers about the settings: all of them with the secrets left out, the
// settings of one tile saved, and a backup exported, imported or saved to a file.

const { readBody } = require('../http/read-body.js');
const { localBackupStamp, BACKUP_MAX_BYTES } = require('./backup-format.js');
const { redactSettingsSecrets } = require('./secrets.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'POST /settings/tile': async (req, res, { json, err500 }, { saveTileSettings }) => {
    let body = null;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { body = null; }
    try {
      const out = await saveTileSettings(body);
      if (!out.ok) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out)); return; }
      json(out);
    } catch (e) { err500(e.message); }
  },

  'GET /backup/export': async (_req, res, { err500 }, { buildBackup }) => {
    // One portable JSON file with the user's configuration (no secrets, no
    // uploaded binaries). Served as a download.
    try {
      const bundle = await buildBackup();
      const name = 'xenon-backup-' + localBackupStamp(new Date()) + '.json';
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`,
      });
      // Compact on purpose: pretty-printing a bundle that can embed a multi-MB
      // background stringifies tens of extra MB synchronously on the event loop.
      res.end(JSON.stringify(bundle));
    } catch (e) { err500(e.message); }
  },

  'POST /backup/import': async (req, _res, { json, err500, isRemote }, { applyBackup }) => {
    try {
      const raw = await readBody(req, BACKUP_MAX_BYTES);
      json(await applyBackup(JSON.parse(raw || '{}'), { remote: isRemote }));
    } catch (e) { err500(e.message); }
  },

  'POST /backup/save': async (req, _res, { json, err500, isRemote }, { _captureHost, chooseBackupFolder, saveBackupToDisk }) => {
    // Embedded-view fallback: the iCUE WebView (and some kiosk browsers) have no
    // download manager, so a blob/anchor download silently does nothing there.
    // Since the server runs on the same PC, write the backup straight to the
    // user's Downloads folder and report the path back for a confirmation toast.
    // `pick: true` asks where first, with the system folder dialog, on the PC
    // only: from a paired device nobody is in front of that dialog. No dialog
    // (no capture engine, it failed) → Downloads.
    try {
      const body = JSON.parse(await readBody(req, 1024) || '{}');
      let dir = '';
      if (body && body.pick === true && !isRemote && _captureHost.has('pick_folder')) {
        const r = await chooseBackupFolder();
        if (r.ok && r.cancelled) { json({ ok: true, cancelled: true }); return; }
        if (!r.ok && r.error === 'picking') { json(r); return; }
        if (r.ok) dir = r.path;
      }
      json(await saveBackupToDisk(dir));
    } catch (e) { err500(e.message); }
  },

  'GET /settings': async (_req, _res, { json, err500 }, { readHubSettings }) => {
    // Redact ALL server-only secrets (remote-control creds, Home Assistant token,
    // OBS/Streamer.bot passwords, EVERY provider API key, lighting pairing
    // tokens) before sending to the browser.
    //
    // geminiApiKey used to be excluded here, on the reasoning that the client
    // needed it. It did not: every use was a presence gate or a `key:` field
    // posted back to an endpoint that already had the key on disk. The gates now
    // read `geminiApiKeySet` and the server swaps the real key in
    // (`geminiKeyFor`), so nothing about the AI changed except that the secret
    // stays on this machine — which matters most on the paired-device door,
    // where the wire is a cleartext LAN.
    try { json({ settings: redactSettingsSecrets(await readHubSettings()) }); }
    catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
