// Reads which letters this keyboard types with AltGr and tells the shortcut checker.

const DeckShortcuts = require('../js/deck-shortcuts.js');
const AltGrKeys = require('../altgr-keys-windows.js');

// What this PC's keyboards type with AltGr: a Ctrl+Alt letter none of them types
// is a shortcut like any other. Read again at most once a minute (altgr-keys-windows.js).
function _altGrKeys() {
  const list = AltGrKeys.altGrKeys();
  DeckShortcuts.useAltGrKeys(list);
  return list;
}

module.exports = { _altGrKeys };
