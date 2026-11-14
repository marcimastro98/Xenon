// The engine's writer of shortcuts into the Linux desktop's own key store; nothing on other
// systems.

const { PORT } = require('../engine/port.js');

// On Linux the shortcut is not a process we own but an entry in the desktop's
// own keybinding store, so there is nothing to spawn, supervise or restart —
// registering is a one-shot write and the state it produces is final until the
// user changes the combo. Kept out of refreshHotkeyListener's process lifecycle
// entirely rather than pretended into it.
const _linuxHotkey = process.platform === 'linux'
  ? require('../linux-hotkey.js').createLinuxHotkey({ port: PORT })
  : null;

module.exports = { _linuxHotkey };
