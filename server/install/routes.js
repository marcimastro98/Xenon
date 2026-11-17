'use strict';
// What the engine answers about opening the dashboard in the browser at sign-in, and the
// shutdown of a start that is still waiting to open it (sign-in-open.js stop).

const { autoOpenSwitch } = require('./auto-open-switch.js');
const signInOpen = require('./sign-in-open.js');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const routes = {
  'GET /startup/auto-open': async (_req, _res, { json, err500 }) => {
    // Whether the switch is shown (`supported`) and whether a real browser asked
    // for the tab (`enabled`): auto-open-switch.js.
    try { json(await autoOpenSwitch.state()); } catch (e) { err500(e.message); }
  },

  'POST /startup/auto-open': async (req, _res, { json, err500, readBody }) => {
    // Posted by the dashboard in a real browser at the PC, and by nothing else:
    // the engine refuses this address to a paired device and to another site.
    try {
      const body = JSON.parse(await readBody(req));
      json(await autoOpenSwitch.turn(!!body && body.enabled === true));
    } catch (e) { err500(e.message); }
  },
};

module.exports = { routes, stop: signInOpen.stop };
