// The settings for incoming calls as the calls module reads them: which apps count, and which
// the user turned off.

const callDetect = require('../call-detect.js');
const { hub } = require('../settings/current.js');

// ── Incoming calls ──────────────────────────────────────────────────────────
// calls.js owns the ring state and performs the answer; everything platform- or
// integration-shaped is injected here so that module stays testable without a
// server. The two sensors are wired at their sources: winNotif.onItem above and
// pushDiscordNotification below.
function callsSettings() {
  const c = (hub.settings && hub.settings.calls) || {};
  const off = Array.isArray(c.disabledApps) ? c.disabledApps : [];
  const userApps = Array.isArray(c.apps) ? c.apps : [];
  // Stored as "which apps did the user switch OFF", handed to the classifier as
  // an explicit allowlist — the friendlier shape to persist, the safer shape to
  // reason about at the boundary. `null` means "no app was switched off".
  let allowed = null;
  if (off.length) {
    allowed = callDetect.DEFAULT_APPS.map(a => a.id)
      .concat(userApps.map(a => a && a.id).filter(Boolean))
      .filter(id => !off.includes(id));
  }
  return { enabled: c.enabled === true, push: c.push !== false, sound: c.sound !== false, apps: userApps, allowed };
}

module.exports = { callsSettings };
