// What the engine answers about the shortcut of the search bar.

const { hub } = require('../settings/current.js');
const { _hotkey } = require('../deck/hotkey-state.js');
const { searchShortcut } = require('./shortcut-claim.js');
const fs = require('node:fs');
const path = require('node:path');
const screenAlertsPage = require('../screen-alerts-page.js');

const SERVER_DIR = path.join(__dirname, '..');

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

  'POST /spotlight/claimed': async (_req, _res, { json }) => {
    // The native kiosk claims the hotkey: it just opened the frameless
    // Spotlight window, so the Edge fallback must NOT also fire. In
    // CSRF_MUTATION_PATHS.
    searchShortcut.claimed = true;
    json({ ok: true });
  },

  'GET /spotlight': async (_req, _res, { sendPage }) => {
    // Spotlight popup document (main-PC window, opened by the global hotkey).
    // Same loopback trust as '/'; no-store like /deck-popup.
    // Bit's chat in that window is the dashboard's panel, cut from index.html.
    const [html, dashboard] = await Promise.all([
      fs.promises.readFile(path.join(SERVER_DIR, 'spotlight.html'), 'utf8'),
      fs.promises.readFile(path.join(SERVER_DIR, 'index.html'), 'utf8'),
    ]);
    await sendPage(screenAlertsPage.compose(html, dashboard));
  },
};

module.exports = { branches };
