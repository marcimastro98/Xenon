'use strict';
// The keys of a placed widget, in its own card and in the Keys section: one that
// shows or hides it, and one per function a Store widget offers. Each is set by a
// capability (capabilities/widget-key.js). A combination the widget's creator
// suggests is only offered: nothing is set until the person picks it. Pure.
//
// st.widgetKeys: [{ id, name, key?: { combo, mode }, handlers: [{ id, name, params, granted, key? }] }]

const LayersModel = require('./js/layers-model.js');
const DeckShortcuts = require('./js/deck-shortcuts.js');
const { k, run, heading, comboText, choiceRow, keyRow, widgetName } = require('./menu-rows.js');
const { handlerKeyId, HANDLER_KEY_PREFIX } = require('./capabilities/widget-key.js');

const SLOT_PREFIX = 'widget-';
const MODES = Object.freeze([['toggle', 'xmenu_wkey_toggle'], ['hold', 'xmenu_wkey_hold']]);

const boxOf = (w, widgets) => (LayersModel.boxes(widgets).find((b) => b.members.some((x) => x.id === w.id)) || { lead: w }).lead;
const packageOf = (st, pkg) => (st.widgetKeys || []).find((p) => p.id === pkg) || null;

// A suggestion worth offering: a real combination nobody reserves.
function suggested(key) {
  const combo = key && DeckShortcuts.normalizeShortcut(key.combo);
  if (!combo || DeckShortcuts.reservedBy(combo)) return null;
  return { combo, mode: key.mode === 'hold' ? 'hold' : 'toggle' };
}

// What the key does, in the words of its way of working; for "hold" without a
// release (Linux) the widget shows for a few seconds instead.
function modeSub(key, st) {
  if (!key.hold) return k('xmenu_wkey_toggle_sub');
  return k((st.layerNow || {}).keyPeek ? 'xmenu_wkey_peek_sub' : 'xmenu_wkey_hold_sub');
}

function showKeyRows(w, st, id) {
  const lead = boxOf(w, st.layers.widgets);
  const key = lead.key || null;
  const set = (change) => ({ type: 'layerWidgetKey', target: w.id, ...change });
  const state = (st.keyStates || {})[SLOT_PREFIX + lead.id];
  const rows = [keyRow(id('key'), k('xmenu_wkey_show'), key ? key.combo : '', state,
    { record: { action: set({}), param: 'shortcut' }, ...(key ? { sub: modeSub(key, st) } : {}) })];
  if (key) {
    const options = MODES.map(([v, label]) => [v, k(label)]);
    rows.push(choiceRow(id('keymode'), k('xmenu_wkey_mode'), key.hold ? 'hold' : 'toggle', options, (v) => set({ mode: v })));
    return rows;
  }
  const offer = w.kind === 'sdk' && suggested((packageOf(st, w.pkg) || {}).key);
  if (offer) {
    rows.push({ kind: 'button', id: id('keyoffer'), label: k('xmenu_wkey_offer', { key: comboText(offer.combo) }), sub: k('xmenu_wkey_offer_sub'),
      action: k('xmenu_wkey_use'), act: run(set({ shortcut: offer.combo, mode: offer.mode })) });
  }
  return rows;
}

// A function that asks for nothing and that the person allowed: one with settings
// to fill is set on the Deck, where they are chosen.
const keyable = (h) => !h.params.length && h.granted;

function handlerRow(pkg, h, st, id) {
  const hit = (st.deck || []).find((d) => d.keyId === handlerKeyId(pkg, h.id));
  const offer = !hit && suggested(h.key);
  return keyRow(id('fn-' + h.id), { text: h.name }, hit ? hit.combo : '', hit ? hit.state : '',
    { record: { action: { type: 'widgetHandlerKey', widget: pkg, handler: h.id }, param: 'shortcut' },
      ...(offer ? { sub: k('xmenu_wkey_suggested', { key: comboText(offer.combo) }) } : {}) });
}

// The rows under "Keys" in a widget's card.
function widgetKeyRows(w, st, id) {
  if (!(st.probes || {}).shortcuts) return [];
  const rows = [{ kind: 'tunehead', id: id('h-keys'), label: k('xmenu_tune_keys') }, ...showKeyRows(w, st, id)];
  const info = w.kind === 'sdk' && packageOf(st, w.pkg);
  if (info) rows.push(...info.handlers.filter(keyable).map((h) => handlerRow(info.id, h, st, id)));
  return rows;
}

// The "Widgets" group of the Keys section: every widget with a key, then every
// function key, so this stays the one place where every key can be found.
function widgetKeyGroup(st) {
  const L = st.layers;
  const shows = LayersModel.boxes(L.widgets).filter((b) => b.lead.key).map(({ lead }) =>
    keyRow('wkey-' + lead.id, widgetName(lead, st), lead.key.combo, (st.keyStates || {})[SLOT_PREFIX + lead.id],
      { sub: modeSub(lead.key, st), record: { action: { type: 'layerWidgetKey', target: lead.id }, param: 'shortcut' } }));
  const fns = (st.deck || []).filter((d) => d.keyId.startsWith(HANDLER_KEY_PREFIX)).map((d) =>
    keyRow('deck-' + d.keyId, { text: d.title || '' }, d.combo, d.state,
      { record: { action: { type: 'deckShortcut', keyId: d.keyId }, param: 'shortcut' } }));
  const rows = [...shows, ...fns];
  return rows.length ? [heading('keys-widgets', 'xmenu_group_widget_keys'), ...rows] : [];
}

module.exports = { widgetKeyRows, widgetKeyGroup, HANDLER_KEY_PREFIX };
