// Two questions about keyboard shortcuts: who already holds a combination, and why each Deck
// shortcut is or is not held.

const DeckShortcuts = require('../js/deck-shortcuts.js');
const LayersModel = require('../js/layers-model.js');
const { _hotkey, MAX_HOTKEY_BINDINGS } = require('./hotkey-state.js');
const { shortcutState } = require('./shortcut-state.js');
const { hub } = require('../settings/current.js');
const { captureOptions } = require('../screens/capture-options.js');

// Who already uses `combo` among the shortcuts the user set (search, pages,
// Deck keys, the replay, the overlay, the menu), `except` the one being set;
// '' when nobody. Set ones count even while not held, so turning the replay or
// the overlay back on never finds its combo taken.
function _comboHeldBy(combo, except) {
  const want = DeckShortcuts.normalizeShortcut(combo);
  if (!want) return '';
  const same = (c) => DeckShortcuts.normalizeShortcut(c) === want;
  const hs = hub.settings || {};
  const search = hs.searchSettings || {};
  if (search.hotkeyEnabled === true && same(search.hotkeyCombo || 'alt+space')) return 'search';
  if ((Array.isArray(hs.pageHotkeys) ? hs.pageHotkeys : []).some((b) => b && same(b.combo))) return 'page';
  const key = shortcutState.found.list.find((k) => k.keyId !== except && same(k.combo));
  if (key) return key.title || 'deck';
  const layers = LayersModel.normalize(hs.layers);
  // A widget's key: `except` is a widget id when its own box is being set.
  const mine = layers.widgets.find((w) => w.id === except);
  const ownBox = (w) => w.id === except || !!(mine && mine.group && w.group === mine.group);
  if (layers.widgets.some((w) => w.key && !ownBox(w) && same(w.key.combo))) return 'widget';
  if (except !== 'overlay' && layers.overlayKey !== 'off' && same(layers.overlayKey)) return 'overlay';
  if (except !== 'menu' && layers.menuKey !== 'off' && same(layers.menuKey)) return 'menu';
  const o = captureOptions();
  if (except !== 'replay' && o.replayKey !== 'off' && same(o.replayKey)) return 'replay';
  return '';
}

// Why each Deck shortcut is or is not held, for the key editor: the helper's
// own verdict when it got one, else the reason it never reached the helper.
function _deckShortcutStatus() {
  const table = _hotkey.bindings || [];
  const refused = DeckShortcuts.planBindings(table.filter((b) => !b.keyId), shortcutState.found.list, MAX_HOTKEY_BINDINGS).refused;
  const out = shortcutState.found.list.map((s) => {
    const bound = table.find((b) => b.keyId === s.keyId);
    const state = bound ? ((_hotkey.slots || {})[bound.slot] || _hotkey.state || 'off') : (refused[s.keyId] || 'off');
    return { keyId: s.keyId, combo: s.combo, title: s.title, state };
  });
  for (const d of shortcutState.found.duplicates) out.push({ keyId: d.keyId, combo: d.combo, title: d.title, state: 'duplicate' });
  return out;
}

module.exports = { _comboHeldBy, _deckShortcutStatus };
