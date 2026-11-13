// The keyboard shortcut that shows or hides the overlay, or nothing when the overlay is empty
// or the shortcut is off.

const DeckShortcuts = require('../js/deck-shortcuts.js');
const LayersModel = require('../js/layers-model.js');
const { hub } = require('../settings/current.js');

// The overlay shortcut's combo, or '' when there is nothing in the overlay to
// show or hide, or the user turned it off.
function _overlayHotkey() {
  const layers = LayersModel.normalize(hub.settings && hub.settings.layers);
  if (!layers.enabled || layers.overlayKey === 'off' || !layers.widgets.some((w) => w.surface === 'overlay')) return '';
  return DeckShortcuts.normalizeShortcut(layers.overlayKey);
}

module.exports = { _overlayHotkey };
