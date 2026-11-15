'use strict';
// Everything Xenon does on the screen, once (plan §34). The Xenon menu draws a
// tile and a key row from each entry, so a function added here is in both, and
// a person can reach every function and give each one a key without a dashboard.
//
// An entry: { id, group, icon, label, name, probe, action | open, keyAction?, ownKey?, returns?, inPlace? }
//   action     the Deck action a tile and a key both run
//   open       the verb a tile uses instead, when it leads to a screen
//   keyAction  what a key runs for an `open` tile (a key has no window to move in)
//   ownKey     the function has its own row in Keys, not a Deck key
//   name       the English title of the Deck key made for it
//   returns    a one-shot: the menu steps aside while it runs and comes back with the result
//   inPlace    nothing on the screen to keep clear: it runs with the menu where it is
// Its line of explanation is xmenu_sub_<id>, in the tile and in the key row.
// Pure: nothing here reads state.

const KEY_PREFIX = 'fn_';
const KEYS_INSTANCE = 'keys';   // the Deck instance that holds them: no `~`, so it is never pruned as an orphan

const GROUPS = Object.freeze([
  { id: 'capture', label: 'deck_cat_capture' },
  { id: 'tools', label: 'xmenu_group_tools' },
  { id: 'perf', label: 'deck_cat_perf' },
  { id: 'xenon', label: 'deck_cat_xenon' },
]);

const screen = (id, verb, icon, label, name) => ({
  id, group: 'xenon', icon, label, name, open: verb, keyAction: { type: 'xenonScreen', screen: id },
});

const FUNCTIONS = Object.freeze([
  { id: 'area', group: 'capture', icon: 'camera', label: 'xmenu_shot', name: 'Screenshot', probe: 'captureRegion', action: { type: 'screenshot', target: 'region', mode: 'take' }, returns: true },
  { id: 'shot', group: 'capture', icon: 'screens', label: 'xmenu_shot_screen', name: 'Whole screen', probe: 'capture', action: { type: 'screenshot', target: 'screen', mode: 'take' }, returns: true },
  { id: 'record', group: 'capture', icon: 'record', label: 'xmenu_record', name: 'Record', probe: 'captureVideo', action: { type: 'record', target: 'screen', audio: 'chosen', webcam: 'chosen', mode: 'toggle' } },
  { id: 'replay', group: 'capture', icon: 'replay', label: 'xmenu_replay_save', name: 'Save replay', probe: 'captureReplay', action: { type: 'replay', mode: 'save' }, ownKey: true, returns: true },
  { id: 'marker', group: 'capture', icon: 'marker', label: 'deck_act_captureMarker', name: 'Mark this moment', probe: 'captureVideo', action: { type: 'captureMarker' }, inPlace: true },
  { id: 'timelapse', group: 'capture', icon: 'timelapse', label: 'deck_act_timelapse', name: 'Timelapse', probe: 'captureLapse', action: { type: 'timelapse', every: '5', target: 'screen', mode: 'toggle' } },
  { id: 'steps', group: 'capture', icon: 'steps', label: 'deck_act_steps', name: 'Record steps', probe: 'captureSteps', action: { type: 'steps', mode: 'toggle' } },
  { id: 'gallery', group: 'capture', icon: 'gallery', label: 'xmenu_gallery', name: 'Gallery', probe: 'capture', open: 'gallery', keyAction: { type: 'gallery', filter: 'all' } },

  { id: 'text', group: 'tools', icon: 'text', label: 'deck_act_screenText', name: 'Copy text from the screen', probe: 'captureOcr', action: { type: 'screenText', target: 'region' }, returns: true },
  { id: 'color', group: 'tools', icon: 'colour', label: 'deck_act_screenColor', name: 'Colour picker', probe: 'captureInspect', action: { type: 'screenColor', format: 'hex' }, returns: true },
  { id: 'measure', group: 'tools', icon: 'ruler', label: 'deck_act_screenMeasure', name: 'Ruler', probe: 'captureMeasure', action: { type: 'screenMeasure' }, returns: true },
  { id: 'draw', group: 'tools', icon: 'draw', label: 'deck_act_screenDraw', name: 'Draw on the screen', probe: 'captureDraw', action: { type: 'screenDraw', mode: 'toggle' } },
  { id: 'pin', group: 'tools', icon: 'pin', label: 'deck_act_screenPin', name: 'Pin to the screen', probe: 'layers', action: { type: 'screenPin' }, returns: true },
  { id: 'cover', group: 'tools', icon: 'cover', label: 'deck_act_screenCover', name: 'Cover private data', probe: 'captureCover', action: { type: 'screenCover' }, returns: true },
  { id: 'bug', group: 'tools', icon: 'bug', label: 'deck_act_bugReport', name: 'Bug report', probe: 'capture', action: { type: 'bugReport' }, returns: true },

  { id: 'why', group: 'perf', icon: 'why', label: 'deck_act_stutterWhy', name: 'Why does it stutter?', probe: 'frameStats', action: { type: 'stutterWhy' }, inPlace: true },
  { id: 'benchmark', group: 'perf', icon: 'benchmark', label: 'deck_act_benchmark', name: 'Benchmark', probe: 'benchmark', action: { type: 'benchmark', mode: 'toggle' } },

  screen('chat', 'chat', 'bit', 'xmenu_bit', 'Ask Bit'),
  { id: 'companion', group: 'xenon', icon: 'companion', label: 'deck_act_gameCompanion', name: 'Game companion', probe: 'gameCompanion', action: { type: 'gameCompanion' } },
  { id: 'dnd', group: 'xenon', icon: 'dnd', label: 'deck_act_dnd', name: 'Do not disturb', probe: 'notifications', action: { type: 'dnd', mode: 'toggle' }, inPlace: true },
  screen('store', 'store', 'store', 'xmenu_store', 'Store'),
  screen('sparks', 'sparks', 'spark', 'xmenu_sparks', 'Sparks'),
  screen('settings', 'settings:general', 'settings', 'settings_title', 'Settings'),
  { ...screen('mixer', 'mixer', 'mixer', 'deck_act_appMixer', 'Mixer'), probe: 'appAudio' },
  screen('whatsnew', 'whatsnew', 'whatsnew', 'xmenu_whatsnew', "What's New"),
  { id: 'edit', group: 'xenon', icon: 'edit', label: 'xmenu_edit', name: 'Move widgets', probe: 'layers', action: { type: 'layersEdit', mode: 'on' }, returns: true },
  { id: 'page', group: 'xenon', icon: 'pages', label: 'xmenu_next_page', name: 'Next widget page', probe: 'widgetPages', action: { type: 'layerPage' }, inPlace: true },
]);

const BY_ID = new Map(FUNCTIONS.map((f) => [f.id, f]));

const functionById = (id) => BY_ID.get(String(id)) || null;
const subKey = (fn) => 'xmenu_sub_' + fn.id;
const keyActionOf = (fn) => (fn && (fn.action || fn.keyAction)) || null;
const available = (fn, probes) => !fn.probe || !!(probes && probes[fn.probe]);

// Does a one-step Deck key (DeckShortcuts.singleAction) do this function? A
// "show the file" key does not, a key for one named page is not "next page", and a
// screenshot key with no target takes the screen.
function matches(fn, does) {
  const a = keyActionOf(fn);
  if (!a || !does || does.type !== a.type || does.mode === 'reveal') return false;
  if (a.type === 'layerPage' && does.page) return false;
  if (a.screen) return does.screen === a.screen;
  return !a.target || does.target === a.target || (!does.target && a.target === 'screen');
}

// The Deck key that runs a function: the one the menu made, else any that does the same.
function keyFor(deck, fn) {
  const list = deck || [];
  return list.find((d) => d.keyId === KEY_PREFIX + fn.id) || list.find((d) => matches(fn, d.does)) || null;
}

module.exports = { FUNCTIONS, GROUPS, KEY_PREFIX, KEYS_INSTANCE, functionById, subKey, keyActionOf, available, matches, keyFor };
