// The key combination that saves the replay, or none while the replay is off, the capture
// program is missing or the person switched the shortcut off.

const DeckShortcuts = require('../js/deck-shortcuts.js');
const { _captureHost } = require('./capture-engine-host.js');
const { captureOptions } = require('./capture-options.js');

// The replay save shortcut's combo, or '' while the replay is off, the engine
// is missing or the user turned the shortcut off: the combo stays free for
// other apps whenever pressing it could not save anything.
function _replayHotkey() {
  const o = captureOptions();
  if (!o.replay || o.replayKey === 'off' || !_captureHost.has('replay')) return '';
  return DeckShortcuts.normalizeShortcut(o.replayKey);
}

module.exports = { _replayHotkey };
