// The engine's phone: calls, messages and contacts of the phone linked to this PC.

const { broadcastSSE } = require('../http/sse-clients.js');
const calls = require('./calls.js');
const { createPhone } = require('./phone.js');
const { HELPER_EXE } = require('../engine/paths.js');
const { phoneSettings } = require('./phone-settings.js');

const phone = createPhone({
  helperExe: HELPER_EXE,
  broadcast: broadcastSSE,
  getSettings: phoneSettings,
  onCallState: (s) => {
    // Taking over the screen is opt-out on its own: the phonebook and the
    // dialler are useful on a second screen that should never interrupt.
    if (phoneSettings().ring === false) return;
    try {
      calls.onPhoneState({
        incoming: s.incoming,
        active: s.active,
        device: phone.deviceName(),
        // Windows reports only THAT a call exists, so the card starts nameless
        // and a mirrored toast fills it in (see calls.onNotification). Linux
        // reads the caller off the same D-Bus object as the state, so when it
        // is there the card is right on its own.
        caller: s.caller || '',
      });
    } catch { /* the ring must never break the phone feed */ }
  },
});

module.exports = { phone };
