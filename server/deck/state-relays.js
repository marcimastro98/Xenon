// The last script states and widget key states sent to the screens, as text, so the same states
// are not sent twice.

const stateRelays = {
  scripts: '',
  widgetKeys: '',   // change guard: identical relays don't rebroadcast
};

module.exports = { stateRelays };
