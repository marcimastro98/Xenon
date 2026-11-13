// What the engine answers about the open windows, and the install of the ad filter of the
// browser tile.

const { runWindowsTool } = require('./windows-tool.js');
const { readBody } = require('../http/read-body.js');
const browserAdblock = require('../embedded-browser-adblock.js');
const { DATA_DIR } = require('../engine/paths.js');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
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
};

module.exports = { branches };
