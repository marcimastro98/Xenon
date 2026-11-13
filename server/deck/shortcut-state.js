// The keyboard shortcuts found on Deck keys, and the timer that tries again when the listener
// could not start.

const shortcutState = {
  // The shortcuts on Deck keys (js/deck-shortcuts.js), refreshed on every Deck
  // write and at boot. The helper is restarted only when a combo or its key moved.
  found: { list: [], duplicates: [] },
  retryTimer: null,
};

module.exports = { shortcutState };
