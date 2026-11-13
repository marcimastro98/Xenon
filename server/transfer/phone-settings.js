// The settings of the paired phone, or none.

const { hub } = require('../settings/current.js');

// ── The paired phone ────────────────────────────────────────────────────────
// Phonebook and call log over Bluetooth, plus the OS's own "a call is ringing"
// signal. That signal is why this is wired into calls.js rather than living
// beside it: for a phone call it REPLACES the notification-text heuristic with
// a fact, and the mirrored toast is demoted to what it is actually good at,
// which is naming the caller.
function phoneSettings() {
  return (hub.settings && hub.settings.phone) || {};
}

module.exports = { phoneSettings };
