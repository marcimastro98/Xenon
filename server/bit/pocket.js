'use strict';
// The quick keys of the person's own Bit's pocket (js/bit-companion/pocket.js): what the Xenon menu does
// in one tap (server/menu/menu-functions.js, the same probes and the same Deck actions) and two keys of
// its own, and which of them the person put there (prefs.keys, checked here). Pure: the route hands in
// the probes; nothing here reads state.

const Menu = require('../menu/menu-functions.js');

// Its own: a 25-minute timer and the microphone, which the menu has no tile for.
const OWN = Object.freeze([
  { id: 'timer', icon: 'timer', label: 'mybit_pocket_timer', action: { type: 'timerStart', label: 'Bit', minutes: '25' } },
  { id: 'mic', icon: 'mic', label: 'deck_act_micMute', action: { type: 'micMute', mode: 'toggle' } },
]);
// From the menu: what runs in one tap and leaves the person where they were.
const FROM_MENU = Object.freeze(['area', 'shot', 'record', 'marker', 'text', 'color', 'draw', 'dnd', 'gallery', 'why', 'companion', 'page']);
const ENTRIES = Object.freeze([...OWN, ...FROM_MENU.map((id) => Menu.functionById(id)).filter(Boolean)]);
const IDS = Object.freeze(ENTRIES.map((e) => e.id));
const MAX_KEYS = 8;
const FREE_KEYS = 4; // more only with the moreKeys extra (perks.js), when the hub keeps it for supporters
// What a new pocket holds until the person changes it.
const USUAL = Object.freeze(['timer', 'mic', 'area', 'dnd']);

/** The person's keys as saved: known ids only, once each, at most MAX_KEYS. */
function normalizeKeys(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const id of raw) {
    if (typeof id === 'string' && IDS.includes(id) && !out.includes(id)) out.push(id);
    if (out.length === MAX_KEYS) break;
  }
  return out;
}

/** Every key this PC can run now: { id, icon, label, act: { run } | { open } }. */
function choices(probes) {
  return ENTRIES.filter((e) => Menu.available(e, probes)).map((e) => ({
    id: e.id, icon: e.icon, label: e.label, act: e.action ? { run: e.action } : { open: e.open },
  }));
}

module.exports = { IDS, MAX_KEYS, FREE_KEYS, USUAL, normalizeKeys, choices };
