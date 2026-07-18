'use strict';

// Settings revisions are SERVER-assigned, and every endpoint that writes the
// settings store must assign them the SAME way. The rev is not bookkeeping: the
// client compares it against its own to decide whether to adopt a broadcast
// (js/settings.js `_runSettingsSseHydrate` skips anything <= its local rev) and
// whether the server copy or its own wins at boot (`localNewer` in
// `_hydrateHubSettingsImpl`). A rev the server assigns BELOW a surface's own
// therefore makes that surface stop adopting changes made on another one.
//
// This lived inline in POST /settings, and when POST /api/weather/config was
// added in v4.6.1 it re-derived the rev from the stored copy alone
// (`prevRev + 1`, ignoring the client's). The city field bumps the local rev per
// keystroke while only the last debounced save reaches the server, so the server
// fell several revisions behind the browser, which then ignored every broadcast
// and kept showing its own stale weather location (GitHub #109). Both endpoints
// now call this single helper — a future writer that forgets the rule can't
// reintroduce the divergence.
//
// The rule: adopt the client's rev when it is already ahead of the stored one,
// otherwise bump the stored one. Either way the result is strictly greater than
// `prevRev`, so the broadcast that follows always exceeds every peer's rev and no
// surface silently diverges.
// Non-finite input is discarded rather than propagated: an Infinity rev would be
// absorbing (`Infinity + 1` is still Infinity, and nothing compares greater), so
// the counter could never increase again and every peer would ignore every later
// broadcast for good — and normalizeHubSettings, which keeps only a finite rev,
// would reset the stored one to 0 on the next write.
function toRev(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function nextSettingsRev(prevRev, incomingRev) {
  const prev = toRev(prevRev);
  const incoming = toRev(incomingRev);
  return incoming > prev ? incoming : prev + 1;
}

module.exports = { nextSettingsRev };
