'use strict';
// A keyboard combination for one function of the Xenon menu. Global shortcuts live
// on Deck keys (js/deck-shortcuts.js), so the Keys section makes a key for the
// function on a Deck of its own, `keys`, which no page draws. No combination takes
// the key away again. A new install starts with the three everyone reaches for, in the
// Ctrl+Shift+F row Xenon already uses (F9 overlay, F10 replay): no system, driver or
// known app holds them, and the same combinations work on every OS.

const DeckModel = require('../js/deck-model.js');
const S = require('../js/deck-shortcuts.js');
const { KEY_PREFIX, KEYS_INSTANCE, functionById, keyActionOf, available, keyFor } = require('../menu-functions.js');
const { checkCombo } = require('./deck-shortcut.js');

const KEYS_GRID = Object.freeze({ cols: 6, rows: 4 });
const DEFAULT_KEYS = Object.freeze({ shot: 'ctrl+shift+f12', record: 'ctrl+shift+f11', area: 'ctrl+shift+f8' });

function removeKey(configs, keyId) {
  const cfg = configs[KEYS_INSTANCE];
  const spot = cfg ? DeckModel.findTopKey(cfg, keyId) : null;
  if (!spot) return { result: { ok: true, shortcut: '' } };
  configs[KEYS_INSTANCE] = DeckModel.setKeyAt(cfg, spot.nav, spot.slot, null);
  return { changed: [KEYS_INSTANCE], result: { ok: true, shortcut: '' } };
}

function saveKey(configs, fn, combo) {
  const keyId = KEY_PREFIX + fn.id;
  const taken = S.collectShortcuts(configs).list.find((s) => s.combo === combo && s.keyId !== keyId);
  if (taken) return { result: { ok: false, error: 'in_use', by: taken.title } };
  const cfg = configs[KEYS_INSTANCE] || DeckModel.normalizeDeckConfig(KEYS_GRID);
  const found = DeckModel.findTopKey(cfg, keyId);
  const spot = found ? { config: cfg, ...found } : DeckModel.firstFreeSlot(cfg);
  const key = { id: keyId, kind: 'action', title: fn.name, triggers: { tap: keyActionOf(fn) }, shortcut: combo };
  configs[KEYS_INSTANCE] = DeckModel.setKeyAt(spot.config, spot.nav, spot.slot, key);
  return { changed: [KEYS_INSTANCE], result: { ok: true, shortcut: S.formatShortcut(combo) } };
}

async function setKey(d, action) {
  if (!d.deck || typeof d.deck.update !== 'function') return { ok: false, error: 'unavailable' };
  const fn = functionById(action.fn);
  if (!fn) return { ok: false, error: 'no_key' };
  const { combo, refused } = checkCombo(d, action.shortcut);
  if (refused) return refused;
  return d.deck.update((configs) => (combo ? saveKey(configs, fn, combo) : removeKey(configs, KEY_PREFIX + fn.id)));
}

// The defaults, once: the `keys` Deck stays after its keys are cleared, so a person
// who took one away never gets it back, and whoever already made one keeps theirs.
async function seedKeys(d) {
  const probes = d.probes();
  if (!probes.shortcuts || !probes.capture) return;
  await d.deck.update((configs) => {
    if (configs[KEYS_INSTANCE]) return {};
    const changed = new Set();
    for (const [id, raw] of Object.entries(DEFAULT_KEYS)) {
      const fn = functionById(id);
      if (!available(fn, probes) || keyFor(S.collectShortcuts(configs).list, fn)) continue;
      const { combo, refused } = checkCombo(d, raw);
      if (refused) continue;
      for (const instance of saveKey(configs, fn, combo).changed || []) changed.add(instance);
    }
    return { changed: [...changed] };
  });
}

module.exports = { setKey, seedKeys, DEFAULT_KEYS };
