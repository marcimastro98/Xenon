// Turns stored settings into the settings the engine saves and sends to every dashboard: every
// key checked, in one fixed order, from eight parts.

const { DASHBOARD_LAYOUT_VERSION } = require('../grid/layout-defaults.js');
const { normalizeHubLook } = require('./normalize-look.js');
const { normalizeHubScreen } = require('./normalize-screen.js');
const { normalizeHubApp } = require('./normalize-app.js');
const { normalizeHubTiles } = require('./normalize-tiles.js');
const { normalizeHubAssistant } = require('./normalize-assistant.js');
const { normalizeHubFeatures } = require('./normalize-features.js');
const { normalizeHubConnections } = require('./normalize-connections.js');
const { normalizeHubInstall } = require('./normalize-install.js');

function normalizeHubSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  // One-time migration: saved layouts older than the current version are
  // replaced with the new default on upgrade (other settings preserved).
  const layoutVersion = Number(source.dashboardLayoutVersion) || 0;
  const resetLayout = layoutVersion < DASHBOARD_LAYOUT_VERSION;
  return {
    ...normalizeHubLook(source),
    ...normalizeHubScreen(source),
    ...normalizeHubApp(source),
    ...normalizeHubTiles(source, resetLayout),
    ...normalizeHubAssistant(source),
    ...normalizeHubFeatures(source),
    ...normalizeHubConnections(source),
    ...normalizeHubInstall(source),
  };
}

module.exports = { normalizeHubSettings };
