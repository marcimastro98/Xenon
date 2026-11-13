// Where the scripts that carry out Deck keys on Windows sit.

const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..');

const DECK_ACTIONS_SCRIPT = path.join(SERVER_DIR, 'deck-actions.ps1');
const DECK_HOTKEY_SCRIPT = path.join(SERVER_DIR, 'deck-hotkey.ps1');
const DECK_WINDOW_SCRIPT = path.join(SERVER_DIR, 'deck-window.ps1');

const DECK_POPUP_TOP_SCRIPT = path.join(SERVER_DIR, 'deck-popup-top.ps1');

module.exports = {
  DECK_ACTIONS_SCRIPT, DECK_HOTKEY_SCRIPT, DECK_WINDOW_SCRIPT, DECK_POPUP_TOP_SCRIPT,
};
