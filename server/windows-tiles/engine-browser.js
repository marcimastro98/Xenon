// The engine's host of the browser a Browser tile shows.

const { createEmbeddedBrowser } = require('../embedded-browser.js');
const browserAdblock = require('./embedded-browser-adblock.js');
const { DATA_DIR } = require('../engine/paths.js');
const { hub } = require('../settings/current.js');

// Embedded-browser host for the "Browser" dashboard widget. Launches ONE headless
// Edge on demand (when a tile opens) and kills it when the last tile closes, so an
// unused widget costs nothing. Frames/input are relayed over a loopback WebSocket
// (see the /embedded-browser/ws upgrade handler near the bottom of this file).
const embeddedBrowser = createEmbeddedBrowser({
  dataDir: DATA_DIR,
  // Opt-in ad-blocker: load the unpacked uBOL extension only when the user enabled
  // it AND it is installed. Read fresh at each Edge launch, so toggling the setting
  // (which tears Edge down — see POST /settings) takes effect on the next open.
  getExtensionDirs: () => {
    try {
      if (hub.settings && hub.settings.browserAdblock === true) {
        const ext = browserAdblock.extensionDir(DATA_DIR);
        if (ext) return [ext];
      }
    } catch (e) { /* never block the browser on an extension-resolver fault */ }
    return [];
  },
});

module.exports = { embeddedBrowser };
