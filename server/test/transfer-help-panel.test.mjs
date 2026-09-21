// "How do I send a file from my phone?" — said in the tile, not only in the docs.
//
// The File transfer tile invited you to send files from your phone ("Drag files
// here, or send them from your phone") and never said how. The steps were in
// FEATURES.md and in nobody's dashboard, and the one step that matters most —
// the phone has to be PAIRED first, or it cannot send anything — is exactly the
// part a tile cannot show you by existing. Asked for on Discord: put a button in
// the widget that explains it.
//
// The phone sheet already printed the boundaries (same network, one at a time,
// the two iOS limits) since 4.11.0. The tile never did. These tests hold the
// panel to the shape that fixes both without saying anything twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const WIDGET = read('../js/transfer-widget.js');
const CSS = read('../components/TransferWidget/TransferWidget.css');
const I18N = read('../js/i18n.js');
const CHANGELOG = read('../../CHANGELOG.md');
const FEATURES = read('../../FEATURES.md');

const HELP_KEYS = [
  'xfer_help', 'xfer_help_to_pc', 'xfer_help_to_pc_1', 'xfer_help_to_pc_2', 'xfer_help_to_pc_3',
  'xfer_help_to_phone', 'xfer_help_to_phone_1', 'xfer_help_to_phone_2', 'xfer_help_where',
];

test('both surfaces get a ?, and both drive the same panel', () => {
  // The tile's header is display:none inside the sheet, so a single button in
  // the header would be invisible on the phone — which is the surface the
  // instructions are mostly about.
  assert.match(WIDGET, /const help = iconBtn\(ICONS\.help, t\('xfer_help'/g);
  assert.equal((WIDGET.match(/iconBtn\(ICONS\.help/g) || []).length, 2, 'the tile head and the sheet bar');
  assert.match(CSS, /\.xfer-sheet \.xfer-head \{ display: none; \}/);
  // One panel, one toggle: the two buttons cannot disagree about its state.
  assert.match(WIDGET, /function toggleHelp\(mount, force\)/);
  assert.match(WIDGET, /root\.querySelectorAll\('\.xfer-help-btn'\)\.forEach/);
  assert.match(WIDGET, /b\.setAttribute\('aria-expanded', String\(open\)\)/);
});

test('the panel is built with the tile, not on first press', () => {
  // ensure() only rebuilds when the mount is empty, so a panel created lazily
  // would be the one piece in here that can go missing.
  assert.match(WIDGET, /zone\.append\(list, drop, helpPanel\(\)\);/);
  assert.match(WIDGET, /function helpPanel\(\)[\s\S]{0,200}box\.hidden = true;/);
});

test('it covers the zone instead of pushing it out of the tile', () => {
  // As a block in the same column flex, opening it squeezed the list to nothing
  // on any tile that was not very tall: the help arrived and the files left.
  const help = CSS.slice(CSS.indexOf('.xfer-help {'));
  const block = help.slice(0, help.indexOf('}') + 1);
  assert.match(block, /position: absolute/);
  assert.match(block, /inset: 0/);
  assert.match(block, /overflow-y: auto/, 'a long panel scrolls inside itself');
  // Opaque, or the file list reads straight through the instructions.
  assert.match(block, /background-color: var\(--panel/);
  const zone = CSS.slice(CSS.indexOf('.xfer-zone {'));
  assert.match(zone.slice(0, zone.indexOf('}') + 1), /position: relative/);
});

test('the pairing step comes first', () => {
  // A phone that was never paired cannot send anything, and that is the step
  // the tile could not have shown you by existing.
  const fn = WIDGET.slice(WIDGET.indexOf('function helpPanel()'));
  const body = fn.slice(0, fn.indexOf('function toggleHelp'));
  const pair = body.indexOf('xfer_help_to_pc_1');
  const open = body.indexOf('xfer_help_to_pc_2');
  const pick = body.indexOf('xfer_help_to_pc_3');
  assert.ok(pair > -1 && pair < open && open < pick, 'pair → open → pick, in that order');
  // Steps in an order are a numbered list, not bullets.
  assert.match(body, /ol\.className = 'xfer-help-steps'/);
  assert.match(CSS, /\.xfer-help-steps \{[\s\S]*?padding-left/);
});

test('both directions are covered, and where the files land', () => {
  const fn = WIDGET.slice(WIDGET.indexOf('function helpPanel()'));
  const body = fn.slice(0, fn.indexOf('function toggleHelp'));
  assert.match(body, /xfer_help_to_pc'/);
  assert.match(body, /xfer_help_to_phone'/);
  assert.match(body, /xfer_help_where/);
});

test('the boundaries come from the one place that already words them', () => {
  // sheetNotes() has carried these since 4.11.0 — copying them would be a
  // second wording to keep in step, and it would drift.
  const fn = WIDGET.slice(WIDGET.indexOf('function helpPanel()'));
  assert.match(fn.slice(0, fn.indexOf('function toggleHelp')), /for \(const line of sheetNotes\(\)\)/);
  // …and the sheet prints them permanently under the list, so inside a sheet
  // the panel's copy would be the same text twice on one screen.
  assert.match(CSS, /\.xfer-sheet \.xfer-help-note \{ display: none; \}/);
});

test('the help is a button, not four permanent lines', () => {
  // A tile you have used once should be a list of files, not a manual.
  const fn = WIDGET.slice(WIDGET.indexOf('function helpPanel()'));
  assert.match(fn.slice(0, 400), /box\.hidden = true;/);
  assert.match(CSS, /\.xfer-help\[hidden\] \{ display: none; \}/);
});

test('every string is in all eleven languages', () => {
  const langs = (I18N.match(/\n\s*xfer_note_lan:/g) || []).length;
  assert.equal(langs, 11, 'the transfer block should exist in every locale');
  for (const key of HELP_KEYS) {
    assert.equal((I18N.match(new RegExp('\\n\\s*' + key + ':', 'g')) || []).length, langs, key);
  }
});

test('no locale left an English placeholder behind', () => {
  // The pairing line is the one that matters most; a copy-pasted English one
  // would be the easiest to miss.
  const all = I18N.match(/xfer_help_to_pc_1: "([^"]+)"/g) || [];
  assert.equal(all.length, 11);
  const english = all.filter((l) => /Pair the phone once/.test(l));
  assert.equal(english.length, 1, 'only the English locale may carry the English line');
});

test('it is written down', () => {
  assert.match(CHANGELOG, /File transfer tile now explains itself/);
  assert.match(FEATURES, /How it works/);
});
