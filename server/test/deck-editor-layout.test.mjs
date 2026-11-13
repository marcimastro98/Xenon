// The key editor reads in the order a key is set up: What it does, State (what
// lights it and the live value it shows), Look (one face at a time: Off, or On
// with only what changes), Effects (tap, motion, LED, the lit-only light).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appStringsSource } from './i18n-source.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const ED = read('../js/deck-editor.js');
const I18N = appStringsSource();

test('the tabs run What it does, State, Look, Effects', () => {
  const defs = ED.slice(ED.indexOf('const TAB_DEFS = ['), ED.indexOf('];', ED.indexOf('const TAB_DEFS = [')));
  assert.deepEqual([...defs.matchAll(/id: '(\w+)'/g)].map((m) => m[1]), ['actions', 'state', 'look', 'fx']);
});

test('each card sits in the tab it belongs to', () => {
  assert.match(ED, /paneLook\.insertBefore\(fLabel, fColor\);/, 'the label is part of the look');
  assert.match(ED, /paneState\.appendChild\(fLive\);/, 'the live value is state, not look');
  assert.doesNotMatch(ED, /paneLook\.appendChild\(fLive\)/);
  assert.match(ED, /paneFx\.appendChild\(fLight\);/, 'the LED reaction is an effect');
  assert.match(ED, /paneFx\.appendChild\(fSsFx\);/, 'ring, dim and the lit motion are effects');
});

test('Look edits one face at a time, and the preview picks the face', () => {
  assert.match(ED, /const litSections = \[ssHint, fSsLabel, fSsIcon, fSsBg\];/);
  assert.match(ED, /litSections\.forEach\(\(n\) => \{ n\.classList\.add\('deck-ed-on-face'\); paneLook\.appendChild\(n\); \}\);/);
  for (const f of ['iconPicker.element', 'fColor', 'fBgImg', 'fLabel']) assert.ok(ED.includes(f + ".classList.add('deck-ed-off-face')"), f);
  assert.match(ED, /paneLook\.dataset\.face = cycleAt \? 'cycle' : f;/);
  assert.match(ED, /const pick = \(\) => \{ setFace\(face\); showTab\('look'\); schedulePreview\(\); \};/);
  assert.match(ED, /faceNever\.style\.display = \(!st && !ownSum\) \? '' : 'none';/, 'an On face nobody will see says so');
  assert.match(ED, /if \(!isAction\) setFace\('off'\);/, 'a folder or slider has one face');
  assert.equal((ED.match(/tab: activeTab, face: lookFace \}/g) || []).length, 2, 'presets and paste keep the face');
  const css = read('../components/DeckPanel/DeckPanel.css');
  assert.match(css, /\.deck-ed-pane\[data-face="on"\] > \.deck-ed-off-face,\n\.deck-ed-pane\[data-face="off"\] > \.deck-ed-on-face \{ display: none; \}/);
  // Saved fields keep their meaning.
  assert.match(ED, /if \(ssColor2Val && ssBgMode === 'grad'\) ss\.color2 = ssColor2Val;/);
  // One Title field: on the On face or a cycle state it edits that face's title.
  assert.match(ED, /inTitle\.placeholder = f \? \(baseTitle\.trim\(\) \|\| t\('deck_ph_statestyle_label'\)\) : '';/);
  assert.match(ED, /if \(f === 'on'\) ssLabelVal = inTitle\.value\.trim\(\);/);
  assert.match(ED, /title: baseTitle,/);
  assert.ok(!/ssLabelIn/.test(ED), 'no second Title box on the On face');
});

test('every label is in all 11 languages and the old ones are gone', () => {
  for (const k of ['deck_tab_actions', 'deck_tab_state', 'deck_tab_look', 'deck_tab_fx', 'deck_triggers', 'deck_ss_hint', 'deck_ss_sec_label', 'deck_ss_sec_icon', 'deck_ss_sec_bg', 'deck_ss_sec_fx', 'deck_look_never_on', 'deck_look_go_state']) {
    assert.equal((I18N.match(new RegExp('^ +"?' + k + '"?: ', 'gm')) || []).length, 11, k);
    assert.match(ED, new RegExp("'" + k + "'"), k + ' is used');
  }
  for (const k of ['deck_edit_statestyle', 'deck_statestyle_hint', 'deck_ss_color', 'deck_ss_color2', 'deck_ss_label']) {
    assert.doesNotMatch(I18N, new RegExp('^ +' + k + ': ', 'm'), k);
    assert.doesNotMatch(ED, new RegExp("'" + k + "'"), k);
  }
});

test('the icon size preset reaches the Comic icon badge', () => {
  assert.match(read('../styles/themes-comic.css'), /width: calc\(max\(34px, 46%\) \* var\(--ico-scale, 1\)\);/);
});

test('a key that never lights up can be made a switch from its On face', () => {
  assert.match(ED, /faceSwitchBtn\.addEventListener\('click', \(\) => \{ behavior\.setMode\('switch'\); schedulePreview\(\); \}\);/);
  assert.doesNotMatch(ED, /deck_toggle_label/, 'the switch is a behaviour now, not a row in State');
  assert.equal((I18N.match(/^ +deck_look_make_switch: /gm) || []).length, 11);
  assert.match(read('../components/DeckPanel/DeckPanel.css'), /\.deck-ed-facebtns \{ display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; \}/);
});

test('on a phone the keys share one row, never wider than the screen', () => {
  const css = read('../components/DeckPanel/DeckPanel.css');
  const phone = css.slice(css.indexOf('@media (max-width: 520px) {\n  .deck-ed-actions'));
  assert.match(phone.slice(0, phone.indexOf('\n}\n')), /\.deck-ed-actions > \.deck-ed-btn \{ flex: 1 1 0; min-width: 0;/);
});

test('a macro from the Xenon menu opens on name, actions and shortcut, the rest behind More options', () => {
  const deck = read('../js/deck.js');
  const open = deck.slice(deck.indexOf('async function openMacro'), deck.indexOf('// Render every deck tile'));
  assert.match(open, /simple: true/);
  assert.match(open, /needsShortcut: true/);
  assert.match(open, /tab: 'actions'/, 'a saved macro opens on what it does, not on its look');
  assert.match(open, /titleKey: keyId \? 'xmenu_key_edit' : 'xmenu_key_new'/);
  assert.match(ED, /\[fKind, behavior\.el, fTrig, fConfirm\]\.forEach\(\(n\) => n\.classList\.add\('deck-ed-advanced'\)\);/);
  const css = read('../components/DeckPanel/DeckPanel.css');
  for (const sel of ['.deck-ed-side', '.deck-ed-tabs', '.deck-ed-advanced']) assert.ok(css.includes('.deck-ed-modal--simple ' + sel), sel);
  assert.match(ED, /opts\.simple = false;/, 'a reopen after More options stays open');
  for (const k of ['deck_edit_more', 'xmenu_key_edit', 'deck_shortcut_needed']) {
    assert.equal((I18N.match(new RegExp('^ +"?' + k + '"?: ', 'gm')) || []).length, 11, k);
  }
});

test('a macro cannot be saved without a shortcut: Keys lists only keys that have one', () => {
  assert.match(ED, /if \(opts\.needsShortcut && !shortcut\.ask\(\)\) return;/);
  assert.match(read('../js/deck-editor-shortcut.js'), /ask\(\) \{ if \(!value\) say\('deck_shortcut_needed', true\); return !!value; \}/);
});
