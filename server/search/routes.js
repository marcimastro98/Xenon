// What the engine answers about the shortcut of the search bar.

const { hub } = require('../settings/current.js');
const { _hotkey } = require('../deck/hotkey-state.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /search/hotkey-status': async (_req, _res, { json, err500 }) => {
    // Settings → Ricerca row: is the global hotkey listening, or why not
    // ('taken' = another app owns the combo, e.g. PowerToys Run on Alt+Space).
    try {
      const ss = (hub.settings && hub.settings.searchSettings) || {};
      json({ state: _hotkey.state, combo: _hotkey.combo || ss.hotkeyCombo || 'alt+space' });
    } catch (e) { err500(e.message); }
  },

  'POST /search/hotkey-press': async (_req, _res, { json, err500 }, { routeSpotlightHotkey }) => {
    // The Linux shortcut's other end. There is no process pushing key events
    // here: the desktop runs a command, and that command is a POST to this.
    // Bound to loopback like the rest of the server, and it carries no payload —
    // pressing it only ever opens Xenon's own search window.
    try { routeSpotlightHotkey(); json({ ok: true }); }
    catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
