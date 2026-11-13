// What the engine answers about the shortcut of the search bar.

const { hub } = require('../settings/current.js');
const { _hotkey } = require('../deck/hotkey-state.js');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const branches = {
  'GET /search/hotkey-status': async (_req, _res, { json, err500 }) => {
    // Settings → Ricerca row: is the global hotkey listening, or why not
    // ('taken' = another app owns the combo, e.g. PowerToys Run on Alt+Space).
    try {
      const ss = (hub.settings && hub.settings.searchSettings) || {};
      json({ state: _hotkey.state, combo: _hotkey.combo || ss.hotkeyCombo || 'alt+space' });
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
