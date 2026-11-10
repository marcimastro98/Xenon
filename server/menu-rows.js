'use strict';
// What the rows of the Xenon menu are made of (server/xenon-menu.js and the
// menu-*.js sections beside it): the row texts, the two kinds of act, and the
// readings more than one section needs. Pure.

const DeckShortcuts = require('./js/deck-shortcuts.js');
const LayersModel = require('./js/layers-model.js');

const k = (key, vars) => (vars ? { key, vars } : { key });
const run = (action) => ({ run: action });
const open = (verb) => ({ open: verb });
const heading = (id, label) => ({ kind: 'heading', id: 'h-' + id, label: k(label) });
// The three sounds of a recording, also the replay's.
const AUDIO_LABELS = Object.freeze({ sound: 'settings_replay_audio_sound', sound_mic: 'settings_replay_audio_mic', silent: 'settings_replay_audio_silent' });
const cornerKey = (corner) => k('xmenu_corner_' + corner.replace('-', '_'));
// The corner of an app a widget is attached to, as the model writes it.
const ANCHOR_CORNERS = Object.freeze({ tr: 'top-right', tl: 'top-left', br: 'bottom-right', bl: 'bottom-left' });
const comboText = (combo) => (combo && combo !== 'off' ? DeckShortcuts.formatShortcut(combo) : '');

// The performance HUD where a person first puts it: small, in a corner.
const HUD_PLACE = Object.freeze({ type: 'layerPlace', widget: 'perf', surface: 'overlay', position: 'top-left', size: 'hud' });

function secondsText(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// The corner a widget sits in, read from its box.
function cornerOf(rect) {
  const v = rect.y + rect.h / 2 < 0.5 ? 'top' : 'bottom';
  const h = rect.x + rect.w / 2 < 0.5 ? 'left' : 'right';
  return v + '-' + h;
}

// Where a box sits, in words that stay true for one dragged to the middle or an edge.
function spotOf(rect) {
  const third = (at) => (at < 1 / 3 ? 0 : at > 2 / 3 ? 2 : 1);
  const v = ['top', '', 'bottom'][third(rect.y + rect.h / 2)];
  const h = ['left', '', 'right'][third(rect.x + rect.w / 2)];
  return [v, h].filter(Boolean).join('-') || 'center';
}

function perfWidget(layers) {
  return layers.widgets.find((w) => w.kind === 'tile' && w.widget === 'perf' && w.surface === 'overlay') || null;
}

// A row of choices that all run the same action with one field changed.
function choiceRow(id, label, value, options, actionFor, sub) {
  return {
    kind: 'choice', id, label, sub, value: String(value),
    options: options.map(([v, text]) => ({ value: String(v), label: text, act: run(actionFor(v)) })),
  };
}

// A key row: the combination, and a line that says whether it works now.
const KEY_NOTES = Object.freeze({
  listening: ['xmenu_key_ok', 'on'], off: ['xmenu_key_idle', 'off'], starting: ['xmenu_key_idle', 'off'],
  taken: ['xmenu_key_taken', 'warn'], full: ['xmenu_key_full', 'warn'], duplicate: ['xmenu_key_dup', 'warn'],
  clash: ['xmenu_key_dup', 'warn'], helper: ['xmenu_key_helper', 'warn'], error: ['xmenu_key_error', 'warn'],
});

function keyRow(id, label, combo, state, extra) {
  const owner = combo && combo !== 'off' ? DeckShortcuts.reservedBy(combo) : '';
  const [note, tone] = owner ? ['deck_shortcut_res_' + owner, 'warn'] : (KEY_NOTES[state] || KEY_NOTES.off);
  return { kind: 'key', id, label, combo: comboText(combo), note: combo && combo !== 'off' ? k(note) : k('xmenu_key_none'), tone, ...extra };
}

// A key with no title goes by what its first step does.
const keyName = (c) => (c.title ? { text: c.title } : k(c.labelKey));

function widgetName(w, st) {
  if (w.kind === 'sdk') return { text: ((st.packages || []).find((p) => p.id === w.pkg) || {}).name || w.pkg };
  const key = LayersModel.isKey(w) && (st.deckKeys || []).find((c) => c.id === w.instance);
  return key ? keyName(key) : k('layout_widget_' + w.widget);
}

function toggleRow(id, label, on, onAction, offAction, sub) {
  return { kind: 'toggle', id, label, sub, on: !!on, acts: { on: run(onAction), off: run(offAction) } };
}

module.exports = {
  HUD_PLACE, AUDIO_LABELS, ANCHOR_CORNERS, k, run, open, heading, cornerKey, spotOf, comboText, secondsText, cornerOf, perfWidget, choiceRow, toggleRow, keyRow, keyName, widgetName,
};
