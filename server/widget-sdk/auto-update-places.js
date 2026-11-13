// Where the widgets that update themselves keep their state, and where a new version waits
// before it replaces the old one.

const path = require('node:path');
const { DATA_DIR } = require('../engine/paths.js');

// Store widgets that update themselves. The decision logic lives in
// widget-auto-update.js; this only hands it the server's own readers and the one
// install path (the staged swap with rollback). Every package still passes
// validateWidgetPayload before a byte is written, and no grant is ever issued.
const WIDGET_AUTO_UPDATE_STATE_PATH = path.join(DATA_DIR, 'widget-auto-update.json');
const SDK_STAGING_DIR = path.join(DATA_DIR, 'widget-staging');   // beside the packages dir, never inside it

module.exports = { WIDGET_AUTO_UPDATE_STATE_PATH, SDK_STAGING_DIR };
