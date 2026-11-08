'use strict';
// Keys for widgets: a combination that shows or hides a placed widget
// (`layerWidgetKey`), and one that runs a function of a Store widget
// (`widgetHandlerKey`). A widget's creator may only suggest a combination in its
// manifest; it is set here, by the person, from the menu or by asking Bit.
//
// The show/hide key lives on the placement (`key` in layers, js/layers-model.js)
// and is pressed through server/widget-keys.js. A function's key is a Deck key
// with an sdkHandler action on the `keys` Deck, like the menu's own functions
// (function-key.js), so it runs through the same grant and rate checks as a
// key on the Deck.
//
// deps: layers { get(), update(edit), catalog() }, heldBy(combo, except),
//       deck { update(edit) }, sdkHandlers() → [{ id, name, handlers: [{ id, name, params, granted }] }]
const crypto = require('crypto');
const LayersModel = require('../js/layers-model.js');
const S = require('../js/deck-shortcuts.js');
const { KEYS_INSTANCE } = require('../menu-functions.js');
const { findPlaced, resolveRef } = require('./layers.js');
const DeckModel = require('../js/deck-model.js');

const OFF_WORDS = new Set(['off', 'none', 'remove', 'clear', 'nessuna', 'no']);
const MODES = Object.freeze(['toggle', 'hold']);
const KEYS_GRID = Object.freeze({ cols: 6, rows: 4 });
const HANDLER_KEY_PREFIX = 'wh_';

// The combination asked for: '' to take it away, or the answer that refuses it.
function readCombo(raw, heldBy, except) {
  const text = String(raw == null ? '' : raw).trim().toLowerCase();
  if (OFF_WORDS.has(text)) return { combo: '' };
  const combo = S.normalizeShortcut(text);
  if (!combo) return { refused: { ok: false, error: 'bad_shortcut', rule: 'two of ctrl, alt, shift, win plus a letter or digit, or one of them plus F1-F12' } };
  const owner = S.reservedBy(combo);
  if (owner) return { refused: { ok: false, error: 'reserved', owner } };
  const by = typeof heldBy === 'function' ? heldBy(combo, except) : '';
  if (by) return { refused: { ok: false, error: 'in_use', by } };
  return { combo };
}

// `shortcut` left out with a `mode` changes only the way the key works.
async function setWidgetKey(d, action) {
  if (!d.layers || typeof d.layers.update !== 'function') return { ok: false, error: 'unavailable' };
  const catalog = await d.layers.catalog();
  const cur = LayersModel.normalize(d.layers.get());
  const found = findPlaced(cur.widgets, action.target, catalog);
  if (found.error) return { ok: false, error: found.error, ids: found.ids };
  const lead = LayersModel.boxes(cur.widgets).find((b) => b.members.some((w) => w.id === found.widget.id)).lead;
  const was = lead.key || null;
  const mode = MODES.includes(action.mode) ? action.mode : (was && was.hold ? 'hold' : 'toggle');
  let combo = was ? was.combo : '';
  if (action.shortcut != null) {
    const read = readCombo(action.shortcut, d.heldBy, lead.id);
    if (read.refused) return read.refused;
    combo = read.combo;
  } else if (!was) {
    return { ok: false, error: 'bad_shortcut' };
  }
  const key = combo ? { combo, ...(mode === 'hold' ? { hold: true } : {}) } : null;
  const res = await d.layers.update((now) => LayersModel.setBoxKey(now, lead.id, key));
  if (!res || res.error) return { ok: false, error: (res && res.error) || 'failed' };
  return { ok: true, widget: lead.id, shortcut: combo ? S.formatShortcut(combo) : '', mode: combo ? mode : '' };
}

// One Deck key per function: the same id every time, so setting it again moves it.
function handlerKeyId(pkg, handler) {
  return HANDLER_KEY_PREFIX + crypto.createHash('sha1').update(pkg + '/' + handler).digest('hex').slice(0, 16);
}

function removeKey(configs, keyId) {
  const cfg = configs[KEYS_INSTANCE];
  const spot = cfg ? DeckModel.findTopKey(cfg, keyId) : null;
  if (!spot) return { result: { ok: true, shortcut: '' } };
  configs[KEYS_INSTANCE] = DeckModel.setKeyAt(cfg, spot.nav, spot.slot, null);
  return { changed: [KEYS_INSTANCE], result: { ok: true, shortcut: '' } };
}

function saveKey(configs, keyId, title, ref, combo) {
  const taken = S.collectShortcuts(configs).list.find((s) => s.combo === combo && s.keyId !== keyId);
  if (taken) return { result: { ok: false, error: 'in_use', by: taken.title } };
  const cfg = configs[KEYS_INSTANCE] || DeckModel.normalizeDeckConfig(KEYS_GRID);
  const found = DeckModel.findTopKey(cfg, keyId);
  const spot = found ? { config: cfg, ...found } : DeckModel.firstFreeSlot(cfg);
  const key = { id: keyId, kind: 'action', title, triggers: { tap: { type: 'sdkHandler', handler: ref, args: '' } }, shortcut: combo };
  configs[KEYS_INSTANCE] = DeckModel.setKeyAt(spot.config, spot.nav, spot.slot, key);
  return { changed: [KEYS_INSTANCE], result: { ok: true, shortcut: S.formatShortcut(combo) } };
}

const lower = (v) => String(v == null ? '' : v).trim().toLowerCase();

// The widget by its package id or its name, and the function by its id or its name.
function findHandler(packages, widget, handler) {
  const withFns = packages.filter((p) => p.handlers.length);
  const ref = resolveRef(widget, { packages: withFns });
  const info = ref && withFns.find((p) => p.id === ref.pkg);
  if (!info) return { refused: { ok: false, error: 'no_widget', choices: withFns.map((p) => p.name || p.id) } };
  const want = lower(handler);
  const fn = info.handlers.find((h) => h.id === String(handler || '')) || info.handlers.find((h) => lower(h.name) === want);
  if (!fn) return { refused: { ok: false, error: 'no_function', choices: info.handlers.map((h) => h.name) } };
  return { info, fn };
}

// A function that asks for nothing: one with settings to fill stays on the Deck editor,
// where those settings are chosen.
async function setHandlerKey(d, action) {
  if (!d.deck || typeof d.deck.update !== 'function' || typeof d.sdkHandlers !== 'function') return { ok: false, error: 'unavailable' };
  const found = findHandler(await d.sdkHandlers(), action.widget, action.handler);
  if (found.refused) return found.refused;
  const { info, fn: handler } = found;
  const pkg = info.id;
  const id = handler.id;
  if (handler.params.length) return { ok: false, error: 'needs_settings' };
  if (!handler.granted) return { ok: false, error: 'not_granted' };
  const keyId = handlerKeyId(pkg, id);
  const read = readCombo(action.shortcut, d.heldBy, keyId);
  if (read.refused) return read.refused;
  const title = ((info.name || pkg) + ' · ' + handler.name).slice(0, 40);
  return d.deck.update((configs) => (read.combo
    ? saveKey(configs, keyId, title, pkg + '/' + id, read.combo)
    : removeKey(configs, keyId)));
}

module.exports = { setWidgetKey, setHandlerKey, handlerKeyId, HANDLER_KEY_PREFIX };
