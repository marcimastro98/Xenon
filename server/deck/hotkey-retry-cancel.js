// Stops the timer that tries again to listen for keyboard shortcuts.

const { shortcutState } = require('./shortcut-state.js');

function _cancelHotkeyRetry() {
  if (shortcutState.retryTimer) { clearTimeout(shortcutState.retryTimer); shortcutState.retryTimer = null; }
}

module.exports = { _cancelHotkeyRetry };
