// What the assistant's trial run of a new preset needs from the engine: the settings check, the
// built-in tiles with their sizes, the SDK switch and the app version.

const { DASHBOARD_WIDGET_IDS, DEFAULT_DASHBOARD_LAYOUT } = require('./layout-defaults.js');
const { APP_VERSION } = require('../updates/app-version.js');
const { normalizeHubSettings } = require('../settings/normalize-hub-settings.js');
const { sdkFeatureEnabled } = require('../widget-sdk/grants.js');

// What the create_preset dry run needs from this file: the real settings
// normalizer, the built-in tile ids with their default sizes, the SDK switch.
function aiPresetDeps() {
  const tiles = DEFAULT_DASHBOARD_LAYOUT.widgets;
  return {
    normalizeSettings: normalizeHubSettings,
    dashboardWidgets: DASHBOARD_WIDGET_IDS.map((id) => ({ id, w: tiles[id] ? tiles[id].w : 8, h: tiles[id] ? tiles[id].h : 6 })),
    sdkEnabled: sdkFeatureEnabled(),
    appVersion: APP_VERSION,
  };
}

module.exports = { aiPresetDeps };
