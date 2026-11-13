// What the engine answers about the open windows, and the install of the ad filter of the
// browser tile.

const { runWindowsTool } = require('./windows-tool.js');
const { readBody } = require('../http/read-body.js');
const browserAdblock = require('../embedded-browser-adblock.js');
const { DATA_DIR } = require('../engine/paths.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /windows': async (_req, _res, { json, err500 }) => {
    try   { json(await runWindowsTool(['list'], 12000)); }
    catch (e) { err500(e.message); }
  },

  'POST /windows/focus': async (req, res, { json, err500 }) => {
    try {
      const { id } = JSON.parse(await readBody(req));
      if (!id || typeof id !== 'string' || !/^\d{1,24}$/.test(id)) {
        res.writeHead(400); res.end('Invalid window id'); return;
      }
      json(await runWindowsTool(['focus', id], 5000));
    } catch (e) { err500(e.message); }
  },

  'POST /windows/close': async (req, res, { json, err500 }) => {
    // Gracefully close a window (WM_CLOSE; the helper refuses protected processes
    // and never force-kills). POST-only, so the loopback Origin/Sec-Fetch checks
    // guard it from a cross-site drive-by.
    try {
      const { id } = JSON.parse(await readBody(req));
      if (!id || typeof id !== 'string' || !/^\d{1,24}$/.test(id)) {
        res.writeHead(400); res.end('Invalid window id'); return;
      }
      json(await runWindowsTool(['close', id], 8000));
    } catch (e) { err500(e.message); }
  },

  'POST /embedded-browser/adblock/install': async (_req, _res, { json }) => {
    // One-click install: download + unpack uBOL. The enable/disable flag is a
    // normal setting saved via POST /settings; this only fetches the extension.
    try {
      const r = await browserAdblock.install(DATA_DIR);
      json({ ok: !!(r && r.ok), installed: browserAdblock.isInstalled(DATA_DIR) });
    } catch (e) {
      json({ ok: false, installed: browserAdblock.isInstalled(DATA_DIR), error: String((e && e.message) || e) });
    }
  },

  'GET /embedded-browser/available': async (_req, _res, { json }, { embeddedBrowser, remoteHttpsInstaller }) => {
    // Lets the Browser widget render a friendly "no browser found" state instead
    // of silently failing.
    //
    // `canInstall` is the difference between a dead end and a button. The widget
    // drives ANY Chromium over the DevTools protocol, and off Windows Chromium
    // is one flatpak away — so a machine without one is not a machine that
    // cannot have one. On Windows this stays false: Edge ships with the OS, so
    // if it is missing something is wrong that installing will not fix.
    json({
      available: embeddedBrowser.available(),
      canInstall: process.platform === 'win32'
        ? false
        : await remoteHttpsInstaller.canInstall('chromium').catch(() => false),
    });
  },

  'POST /embedded-browser/install': async (req, _res, { json, err500 }, { embeddedBrowser, remoteHttpsInstaller }) => {
    // One click, same machinery as everything else: flatpak where it can (no
    // password at all), the distribution's package manager behind one
    // authorisation prompt otherwise.
    try {
      await readBody(req);
      if (process.platform === 'win32') { json({ ok: false, error: 'unsupported' }); return; }
      const r = await remoteHttpsInstaller.install('chromium');
      // `available()` re-probes the filesystem, so this is the real answer
      // rather than the installer's opinion of itself.
      json({ ok: r.code === 0 && embeddedBrowser.available(), reason: r.reason || '' });
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
