// What the engine answers about drawing over the screen: whether the drawing sheet is open.

const fs = require('node:fs');
const path = require('node:path');
const screenAlertsPage = require('../screen-alerts-page.js');

const SERVER_DIR = path.join(__dirname, '..');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /screen-draw': async (_req, _res, { json }, { drawShell }) => {
    // Whether the drawing sheet is open (screen-draw-shell.js), for a page that
    // (re)connects; changes arrive over SSE `screen_draw`. Read-only.
    json({ drawing: drawShell.get() });
  },

  'GET /screen-alerts': async (_req, _res, { sendPage }) => {
    // "Widgets only": the small click-through window that shows the dashboard's
    // pop-ups on the main screen (js/screen-alerts.js). Denied to a paired device
    // in remote-access.js; loopback only, like '/'. Bit's voice panel comes
    // from index.html (screen-alerts-page.js).
    const [page, dashboard] = await Promise.all([
      fs.promises.readFile(path.join(SERVER_DIR, 'screen-alerts.html'), 'utf8'),
      fs.promises.readFile(path.join(SERVER_DIR, 'index.html'), 'utf8').catch(() => ''),
    ]);
    await sendPage(screenAlertsPage.compose(page, dashboard));
  },

  'GET /draw': async (_req, _res, { sendPage }) => {
    // The drawing sheet on macOS and Linux (js/screen-draw-page.js), shown by
    // the shell while drawing is on (screen-draw-shell.js). Denied to a paired
    // device in remote-access.js.
    await sendPage(await fs.promises.readFile(path.join(SERVER_DIR, 'draw.html'), 'utf8'));
  },
};

module.exports = { branches };
