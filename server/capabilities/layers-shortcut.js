'use strict';
// The keyboard shortcuts of the layers: how one is shown, how the overlay, menu and pad
// shortcuts are set, and the hint that tells which key brings the overlay up.

const LayersModel = require('../js/layers-model.js');
const DeckShortcuts = require('../js/deck-shortcuts.js');

// So the AI can tell the person how to show and hide it over a game.
function overlayHint(widget, layers) {
  return widget.surface === 'overlay' && layers.overlayKey !== 'off' ? { toggleShortcut: shortcutText(layers.overlayKey) } : {};
}

// The ready-made shortcuts: `key` overlay (shows and hides the overlay, the
// default) or menu (opens the Xenon menu); a combo, or "off". The same rules as
// a Deck key's shortcut (js/deck-shortcuts.js).
const SHORTCUT_KEYS = Object.freeze({
  overlay: { field: 'overlayKey', fallback: LayersModel.OVERLAY_KEY },
  menu: { field: 'menuKey', fallback: LayersModel.MENU_KEY },
});
function shortcutText(combo) {
  return combo === 'off' ? 'off' : DeckShortcuts.formatShortcut(combo);
}
// `key` pad: holding View + Menu on a controller opens the Xenon menu;
// `combo` on, off or toggle (empty = on, the default).
async function padShortcut(d, action) {
  const raw = String(action.combo || '').trim().toLowerCase();
  const cur = LayersModel.normalize(d.layers.get && d.layers.get()).menuPad;
  const on = { on: true, '': true, off: false, none: false, toggle: !cur }[raw];
  if (on === undefined) return { ok: false, error: 'bad_shortcut' };
  const res = await d.layers.update(c => ({ layers: { ...LayersModel.normalize(c), menuPad: on } }));
  if (!res || res.error) return { ok: false, error: (res && res.error) || 'failed' };
  return { ok: true, key: 'pad', shortcut: res.layers.menuPad ? 'on' : 'off' };
}

async function shortcut(d, action) {
  if (action.key === 'pad') return padShortcut(d, action);
  const which = SHORTCUT_KEYS[action.key] ? action.key : 'overlay';
  const { field, fallback } = SHORTCUT_KEYS[which];
  const raw = String(action.combo || '').trim().toLowerCase();
  let combo = 'off';
  if (raw !== 'off' && raw !== 'none' && raw !== '') {
    combo = DeckShortcuts.normalizeShortcut(raw);
    if (!combo) return { ok: false, error: 'bad_shortcut' };
    const owner = DeckShortcuts.reservedBy(combo);
    if (owner) return { ok: false, error: 'reserved', owner };
    const other = which === 'menu' ? 'overlayKey' : 'menuKey';
    if (LayersModel.normalize(d.layers.get && d.layers.get())[other] === combo) return { ok: false, error: 'reserved', owner: 'xenon' };
    // A search, page or Deck key shortcut on the same combo would lose the press.
    const by = typeof d.heldBy === 'function' ? d.heldBy(combo, which) : '';
    if (by) return { ok: false, error: 'in_use', by };
  } else if (raw === '') {
    combo = fallback;   // no combo = back to the default
  }
  const res = await d.layers.update(cur => ({ layers: { ...LayersModel.normalize(cur), [field]: combo } }));
  if (!res || res.error) return { ok: false, error: (res && res.error) || 'failed' };
  return { ok: true, key: which, shortcut: shortcutText(res.layers[field]) };
}

module.exports = { overlayHint, SHORTCUT_KEYS, shortcutText, padShortcut, shortcut };
