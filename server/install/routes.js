// What the engine answers about opening the dashboard at sign-in.

const { getBrowserAutoOpenState, setBrowserAutoOpen } = require('./browser-auto-open-task.js');
const { AUTO_OPEN_SUPPORTED } = require('./browser-auto-open.js');
const { readBody } = require('../http/read-body.js');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const branches = {
  'GET /startup/auto-open': async (_req, _res, { json, err500 }) => {
    // Reports whether opening the dashboard in the browser at logon is supported
    // (Windows only) and whether the logon task currently exists.
    try {
      const state = await getBrowserAutoOpenState();
      // `reason` tells the dashboard the difference between "you have this off"
      // and "this cannot work here": without it the client would keep posting
      // enabled=true on every page load against a launcher that is not there.
      json({
        ok: true,
        supported: AUTO_OPEN_SUPPORTED,
        enabled: state.enabled,
        reason: state.launcher === 'missing' ? 'launcher_missing' : undefined,
      });
    } catch (e) { err500(e.message); }
  },

  'POST /startup/auto-open': async (req, _res, { json, err500 }) => {
    try {
      const body = JSON.parse(await readBody(req));
      const state = await setBrowserAutoOpen(body && body.enabled === true);
      json({ ok: true, supported: AUTO_OPEN_SUPPORTED, enabled: state.enabled, reason: state.reason });
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
