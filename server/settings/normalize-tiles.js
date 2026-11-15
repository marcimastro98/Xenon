// What stored settings are turned into before they are saved or sent, fourth part: the Browser
// tile, the dashboard's layout and its presets, saved themes and scenes, the streaming
// connections and the favourites.

const {
  DASHBOARD_LAYOUT_VERSION, DEFAULT_DASHBOARD_LAYOUT,
} = require('../grid/layout-defaults.js');
const {
  normalizeServerBrowserTiles, normalizeServerBrowserFavorites, normalizeServerAppFavorites,
} = require('./normalize-favorites.js');
const { sanitizeDashboardPresets } = require('./normalize-passthrough.js');
const { cloneDashboardLayout } = require('../grid/layout-normalize-parts.js');
const contentInstalls = require('../js/store-catalog/content-installs.js');
const { sanitizeCustomThemes } = require('../look/custom-themes.js');
const { sanitizeAmbientScenes } = require('../ambient/scenes-sanitize.js');
const { normalizeDashboardLayout } = require('../grid/layout-normalize.js');

function normalizeHubTiles(source, resetLayout) {
  return {
    browserAdblock: source.browserAdblock === true,
    dashboardLayout: resetLayout
      ? cloneDashboardLayout(DEFAULT_DASHBOARD_LAYOUT)
      : normalizeDashboardLayout(source.dashboardLayout),
    dashboardLayoutVersion: DASHBOARD_LAYOUT_VERSION,
    // Client-owned saved presets (widget/tab-group/page templates). Re-validated
    // by the client (DashboardPresets); the server just round-trips a bounded
    // array so they survive a restart instead of being stripped.
    dashboardPresets: sanitizeDashboardPresets(source.dashboardPresets),
    // Client-owned imported themes (Aspetto → Temi gallery). Re-validated on the
    // client (normalizeCustomThemes); the server just round-trips a bounded array
    // so they survive a restart instead of being stripped.
    customThemes: sanitizeCustomThemes(source.customThemes),
    ambientScenes: sanitizeAmbientScenes(source.ambientScenes),
    contentInstalls: contentInstalls.normalizeContentInstalls(source.contentInstalls),
    geminiApiKey: String(source.geminiApiKey || '').trim().slice(0, 200),
    obsHost: String(source.obsHost || '').trim().slice(0, 200),
    obsPort: Math.max(1, Math.min(65535, parseInt(source.obsPort, 10) || 4455)),
    obsPassword: String(source.obsPassword || '').slice(0, 200),
    obsAutoLaunch: typeof source.obsAutoLaunch === 'boolean' ? source.obsAutoLaunch : true,
    streamerbotHost: String(source.streamerbotHost || '').trim().slice(0, 200),
    streamerbotPort: Math.max(1, Math.min(65535, parseInt(source.streamerbotPort, 10) || 8080)),
    streamerbotPassword: String(source.streamerbotPassword || '').slice(0, 200),
    // Per-instance Browser-widget URLs (client-owned). Round-tripped so they
    // survive a browser-storage reset; the relay re-validates before navigating.
    browserTiles: normalizeServerBrowserTiles(source.browserTiles),
    // Global Browser-widget favorites (client-owned). Round-tripped so the shared
    // quick-access list survives a browser-storage reset; the relay re-validates
    // http/https before navigating.
    browserFavorites: normalizeServerBrowserFavorites(source.browserFavorites),
    // App-switcher favorites (client-owned). Round-tripped so starred apps survive a
    // browser-storage reset; /windows/launch re-validates the path before launching.
    appFavorites: normalizeServerAppFavorites(source.appFavorites),
  };
}

module.exports = { normalizeHubTiles };
