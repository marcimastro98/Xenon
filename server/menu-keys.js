'use strict';
// The "Keys" section of the Xenon menu: Xenon's own keys, then a key for every
// function (server/menu-functions.js), then the rest of the Deck's keys. Pressing
// a combination on a function row makes its key (capabilities/function-key.js),
// or changes the Deck key that already does the same thing.

const DeckShortcuts = require('./js/deck-shortcuts.js');
const { FUNCTIONS, GROUPS, KEY_PREFIX, KEYS_INSTANCE, subKey, available, keyFor } = require('./menu-functions.js');
const { k, run, open, heading, keyRow } = require('./menu-rows.js');
const { widgetKeyGroup, HANDLER_KEY_PREFIX } = require('./menu-widget-keys.js');

function ownKeys(st) {
  const s = st.keyStates || {};
  const L = st.layers;
  const p = st.probes || {};
  const rows = [];
  if (p.layers) {
    // The one key that always has to work: it can change, never go.
    rows.push(keyRow('menuKey', k('xmenu_key_menu'), L.menuKey, s.menu, { noClear: true, record: { action: { type: 'layersShortcut', key: 'menu' }, param: 'combo' } }));
    rows.push(keyRow('overlayKey', k('xmenu_key_overlay'), L.overlayKey, s.overlay, { record: { action: { type: 'layersShortcut', key: 'overlay' }, param: 'combo' } }));
    // A game controller opens the menu too (View + Menu held, layers/pad.rs).
    if (p.menuPad) {
      rows.push({ kind: 'toggle', id: 'menuPad', label: k('xmenu_key_pad'), sub: k('xmenu_key_pad_sub'), on: L.menuPad !== false,
        acts: { on: run({ type: 'layersShortcut', key: 'pad', combo: 'on' }), off: run({ type: 'layersShortcut', key: 'pad', combo: 'off' }) } });
    }
  }
  // With no function rows below, saving the replay keeps its key up here.
  if (p.captureReplay && !p.shortcuts) rows.push(replayKeyRow(st));
  rows.push(...settingsKeys(st));
  return rows;
}

// The search window and the page shortcuts are set in Settings, so here they are
// listed (read-only) to make this the one place every Xenon key can be found.
const PAGE_MOVES = Object.freeze({ next: 'settings_pagehk_move_next', prev: 'settings_pagehk_move_prev', back: 'settings_pagehk_move_back' });

// Instant Replay's own key (capture.replayKey), not a Deck key. It sits with the
// capture keys next to Record: up with the menu's keys it read as the same thing.
function replayKeyRow(st) {
  const s = st.keyStates || {};
  return keyRow('replayKey', k('xmenu_key_replay'), (st.capture || {}).replayKey, s.replay,
    { sub: k('xmenu_sub_replay'), record: { action: { type: 'replayOptions' }, param: 'shortcut' } });
}
const OWN_KEY_ROWS = Object.freeze({ replay: replayKeyRow });

function settingsKeys(st) {
  const s = st.keyStates || {};
  const search = st.searchKey || {};
  const rows = [keyRow('searchKey', k('xmenu_key_search'), search.on ? search.combo : '', s.spotlight, { goes: open('settings:search') })];
  (st.pageKeys || []).forEach((b, i) => {
    const goes = PAGE_MOVES[b.target] ? k(PAGE_MOVES[b.target]) : { text: String(b.target || '') };
    rows.push(keyRow('pageKey-' + i, k('settings_pagehk_title'), b.combo, s['page-' + i], { sub: goes, goes: open('settings:general') }));
  });
  return rows;
}

function functionRow(fn, hit) {
  const own = !hit || hit.keyId === KEY_PREFIX + fn.id;
  const record = own ? { action: { type: 'functionKey', fn: fn.id }, param: 'shortcut' }
    : { action: { type: 'deckShortcut', keyId: hit.keyId }, param: 'shortcut' };
  const row = keyRow('fn-' + fn.id, k(fn.label), hit ? hit.combo : '', hit ? hit.state : '', { record, sub: k(subKey(fn)) });
  return hit ? row : { ...row, note: null };
}

function functionRows(st, used) {
  const rows = [];
  for (const g of GROUPS) {
    const fns = FUNCTIONS.filter((fn) => fn.group === g.id && (!fn.ownKey || OWN_KEY_ROWS[fn.id]) && available(fn, st.probes));
    if (fns.length) rows.push(heading('keys-' + g.id, g.label));
    for (const fn of fns) {
      if (fn.ownKey) { rows.push(OWN_KEY_ROWS[fn.id](st)); continue; }
      const hit = keyFor(st.deck, fn);
      if (hit) used.add(hit.keyId);
      rows.push(functionRow(fn, hit));
    }
  }
  return rows;
}

function deckRow(d) {
  const edit = d.instance === KEYS_INSTANCE ? { edit: open('macro:' + d.keyId) } : {};
  return keyRow('deck-' + d.keyId, d.title ? k('xmenu_key_deck', { name: d.title }) : k('xmenu_key_deck_untitled'), d.combo, d.state,
    { record: { action: { type: 'deckShortcut', keyId: d.keyId }, param: 'shortcut' }, ...edit });
}

function keysSection(st) {
  const used = new Set();
  // First: under thirty functions nobody would find it.
  const rows = [{ kind: 'button', id: 'newKey', label: k('xmenu_key_new'), sub: k('xmenu_key_new_sub'), action: k('xmenu_do_create'), act: open('macro'), primary: true, closes: true }, ...ownKeys(st)];
  if ((st.probes || {}).shortcuts) rows.push(...functionRows(st, used));
  rows.push(...widgetKeyGroup(st));
  const others = (st.deck || []).filter((d) => !used.has(d.keyId) && !d.keyId.startsWith(KEY_PREFIX) && !d.keyId.startsWith(HANDLER_KEY_PREFIX));
  if (others.length) rows.push(heading('keys-deck', 'xmenu_group_macros'), ...others.map(deckRow));
  return rows;
}

module.exports = { keysSection, functionRow };
