// What the user has allowed each installed widget to see and do, read from the settings: with
// widgets switched off, in safe mode or for a paused widget, nothing is allowed.

const { hub } = require('../settings/current.js');

// Whether the third-party widget SDK is enabled at all. The master toggle is the
// kill-switch: with it off, no SDK ingress (fetch proxy, webhooks, deck macros)
// may act, even if stale grants linger in settings.json.
function sdkFeatureEnabled() {
  // Safe mode is an EFFECTIVE off for every SDK surface, server side included:
  // without this, deck MACROS (executed here via /actions/run), the fetch proxy
  // and webhooks kept acting for "paused" third-party packages — a false
  // negative in the exact triage safe mode exists for. The stored enabled flag
  // and grants stay untouched, matching the client's sdk() mask.
  if (hub.settings && hub.settings.safeMode === true) return false;
  const sw = hub.settings && hub.settings.sdkWidgets;
  return !!(sw && sw.enabled === true);
}

// A package the user paused from the Store's Installed tab. Server-side twin of
// the client's isSuspended: the suspend card promises "its Deck keys are paused
// too", which must cover server-executed macro steps, not only handler frames.
function sdkPkgSuspended(pkgId) {
  const sw = hub.settings && hub.settings.sdkWidgets;
  const s = sw && Array.isArray(sw.suspended) ? sw.suspended : [];
  return typeof pkgId === 'string' && s.includes(pkgId);
}

// The user's per-package SDK grants (client-owned schema, round-tripped through
// settings). Read defensively — a malformed blob collapses to "nothing granted".
// A disabled SDK (or a suspended package) grants nothing, so every server-side
// consent check fails closed.
function sdkGrantsFor(pkgId) {
  if (!sdkFeatureEnabled() || sdkPkgSuspended(pkgId)) return { streams: [], actions: [], hosts: [], hooks: [], handlers: [], userHosts: {} };
  const sw = hub.settings && hub.settings.sdkWidgets;
  const g = sw && sw.grants && typeof sw.grants === 'object' ? sw.grants[pkgId] : null;
  return {
    // `streams` is read here too: the audio-meter host decides whether to run at
    // all from "has anyone been granted audioLevels", so it needs the same
    // fail-closed reader every other consent check uses.
    streams: (g && Array.isArray(g.streams)) ? g.streams : [],
    actions: (g && Array.isArray(g.actions)) ? g.actions : [],
    hosts: (g && Array.isArray(g.hosts)) ? g.hosts : [],
    hooks: (g && Array.isArray(g.hooks)) ? g.hooks : [],
    handlers: (g && Array.isArray(g.handlers)) ? g.handlers : [],
    storage: !!(g && g.storage === true),
    // The shared store group the user approved ('' = the package's own store;
    // null = a grant from before the group was recorded, which
    // migrateSdkGrantGroups fills in at start). /sdk/store opens a group only
    // when it is this one.
    storageGroup: (g && typeof g.storageGroup === 'string') ? g.storageGroup : null,
    secrets: !!(g && g.secrets === true),
    // Questions to the AI set for Bit (POST /sdk/ai).
    ai: !!(g && g.ai === true),
    // Raw addresses the user typed into the manifest's userHosts slots. Passed
    // to sdkWidgets.resolveUserHosts, which is what validates them — never read
    // as an allowlist directly.
    userHosts: (g && g.userHosts && typeof g.userHosts === 'object' && !Array.isArray(g.userHosts)) ? g.userHosts : {},
  };
}

// Whether ANY installed package has been granted a data stream. The demand gate
// for server work that exists only to feed widgets: fails closed with
// sdkGrantsFor, so safe mode and a suspended package cost nothing.
function sdkStreamGranted(stream) {
  const sw = hub.settings && hub.settings.sdkWidgets;
  const grants = sw && sw.grants && typeof sw.grants === 'object' ? sw.grants : null;
  if (!grants) return false;
  return Object.keys(grants).some((pkgId) => sdkGrantsFor(pkgId).streams.includes(stream));
}

// Some installed package actually GRANTED this stream (sdkGrantsFor applies safe
// mode and per-package suspend, so both switch the feed off for free).
function _sdkStreamGranted(stream) {
  const sw = hub.settings && hub.settings.sdkWidgets;
  const grants = sw && sw.grants && typeof sw.grants === 'object' ? sw.grants : null;
  if (!grants) return false;
  for (const pkgId of Object.keys(grants)) {
    if (sdkGrantsFor(pkgId).streams.includes(stream)) return true;
  }
  return false;
}

module.exports = {
  sdkFeatureEnabled, sdkPkgSuspended, sdkGrantsFor, sdkStreamGranted, _sdkStreamGranted,
};
