// The page the engine answers with for the scene window: the animated background on a screen of
// its own.

const fs = require('node:fs');
const path = require('node:path');
const scenePage = require('../scene-page.js');

const SERVER_DIR = path.join(__dirname, '..');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const branches = {
  'GET /scene': async (_req, _res, { sendPage }) => {
    // The desktop scene (js/screen-scene.js): the Ambient scene as the animated
    // wallpaper or the screensaver, one shell window per screen. Denied to a
    // paired device in remote-access.js; the overlays come from index.html
    // (scene-page.js). The key is read by the page, never by this route.
    const [page, dashboard] = await Promise.all([
      fs.promises.readFile(path.join(SERVER_DIR, 'scene.html'), 'utf8'),
      fs.promises.readFile(path.join(SERVER_DIR, 'index.html'), 'utf8').catch(() => ''),
    ]);
    await sendPage(scenePage.compose(page, dashboard));
  },
};

module.exports = { branches };
