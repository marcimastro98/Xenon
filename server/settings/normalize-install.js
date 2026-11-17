// What stored settings are turned into before they are saved or sent, eighth part: which screen
// it shows on, game mode and safe mode, performance, the second screen, widget grants, the
// number of the save and the language.

const { SETTINGS_STORE_ID_RE } = require('./store-file.js');
const {
  SDK_WIDGETS_SETTINGS_MAX, sanitizeServerPassthrough,
} = require('./normalize-passthrough.js');
const { normalizeSurfaceChoice, surfaceChoiceFrom } = require('./normalize-surface.js');
const { normalizeServerOnboarding } = require('../first-run/settings-normalize.js');
const { WEATHER_LANGS } = require('../weather/setting-values.js');

function normalizeHubInstall(source) {
  return {
    surfaceChoice: normalizeSurfaceChoice(surfaceChoiceFrom(source)),
    // Client-managed settings (the client owns their full schema and re-validates
    // on load): round-trip them so they survive a server restart instead of being
    // stripped. A bounded passthrough keeps settings.json safe.
    gameMode: typeof source.gameMode === 'boolean' ? source.gameMode : true,
    bgGuard: typeof source.bgGuard === 'boolean' ? source.bgGuard : true,
    // Safe mode: temporarily disables third-party widgets and custom theming
    // (nothing is uninstalled). Client-enforced; persisted so it survives restarts.
    safeMode: source.safeMode === true,
    performance: sanitizeServerPassthrough(source.performance),
    // Smart context profiles (client-owned schema; the client re-validates on load).
    contextProfiles: sanitizeServerPassthrough(source.contextProfiles),
    // Second-screen capture prefs (client-owned; the client re-validates on load).
    secondScreen: sanitizeServerPassthrough(source.secondScreen),
    // Third-party widget SDK: feature flag + per-tile package assignments + the
    // per-package permission grants (client-owned schema; the client re-validates
    // on load, and the bridge enforces grants before any action is dispatched).
    // Its own, larger cap: the client keeps up to 32 grants, each carrying its
    // streams, actions, hosts, hooks, handlers and filled-in addresses — about
    // 330 bytes typical and over 2 KB for a widget that asks for everything. At
    // the shared 8000 the whole object was DROPPED past roughly two dozen
    // widgets, taking every grant and assignment with it in silence.
    sdkWidgets: sanitizeServerPassthrough(source.sdkWidgets, SDK_WIDGETS_SETTINGS_MAX),
    // Monotonic save revision (client-owned): round-tripped so the client's
    // boot-time merge can compare it against the local copy and avoid clobbering
    // a newer local layout with a stale server one.
    rev: Number.isFinite(source.rev) && source.rev > 0 ? Math.floor(source.rev) : 0,
    // Identity of THIS settings store — see the mint in writeHubSettings.
    storeId: SETTINGS_STORE_ID_RE.test(String(source.storeId || '')) ? String(source.storeId) : '',
    // The guided tour's last version taken (client-owned; the tour is gone since 5.2.0):
    // round-tripped because above 0 it still tells an update from a new install.
    onboarding: normalizeServerOnboarding(source.onboarding),
    // Persisted UI language ('' = follow the browser). Round-tripped so the
    // user's choice survives a browser-storage reset (e.g. a Windows restart).
    language: WEATHER_LANGS.has(source.language) ? source.language : '',
  };
}

module.exports = { normalizeHubInstall };
