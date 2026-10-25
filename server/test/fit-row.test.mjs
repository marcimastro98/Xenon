// Rows of controls step down to a more compact layout instead of wrapping into
// a lopsided pile (the System tabs folding into a column, the Deck behaviour
// buttons breaking 3 + 2 at random widths). fit-row.js picks the level; the CSS
// of each row defines what a level looks like.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// A row whose parts are too wide below `fitsFrom`: level n fits when n >= fitsFrom.
function fakeRow(fitsFrom, levels) {
  const row = {
    isConnected: true, clientWidth: 300, children: [], dataset: { fitLevels: String(levels) },
    closest: () => row,
    querySelectorAll: () => [],
    get scrollWidth() { return Number(row.dataset.fit) >= fitsFrom ? 300 : 340; },
  };
  return row;
}

function withResizeObserver(fn) {
  const observed = [];
  globalThis.ResizeObserver = class { observe(n) { observed.push(n); } unobserve(n) { observed.splice(observed.indexOf(n), 1); } };
  try { return fn(observed); } finally { delete globalThis.ResizeObserver; }
}

const FitRow = require('../js/fit-row.js');

test('the first level that fits wins, the last one when none does', () => {
  assert.equal(FitRow.pick(4, (lv) => lv >= 2), 2);
  assert.equal(FitRow.pick(4, () => true), 0);
  assert.equal(FitRow.pick(4, () => false), 3);
  assert.equal(FitRow.pick(1, () => false), 0);
  assert.equal(FitRow.pick(0, () => false), 0);
});

test('a row overflows when it or one of its buttons is wider than its box', () => {
  const btn = { clientWidth: 80, scrollWidth: 80 };
  const row = { clientWidth: 300, scrollWidth: 300, children: [], querySelectorAll: () => [btn] };
  assert.equal(FitRow.overflows(row), false);
  btn.scrollWidth = 95;   // its label cut off
  assert.equal(FitRow.overflows(row), true);
  btn.scrollWidth = 80;
  row.scrollWidth = 330;  // the row spills sideways
  assert.equal(FitRow.overflows(row), true);
  // A label hidden for screen readers is 1px wide on purpose; a 0-wide part is not measured.
  const hidden = { clientWidth: 0, scrollWidth: 60 };
  assert.equal(FitRow.overflows({ clientWidth: 300, scrollWidth: 300, children: [hidden], querySelectorAll: () => [] }), false);
});

test('watching a row sets the lowest level that fits, and stops cleanly', () => withResizeObserver((observed) => {
  const row = fakeRow(2, 3);
  const stop = FitRow.watch(row);
  assert.equal(row.dataset.fit, '2');
  assert.ok(observed.includes(row));
  stop();
  assert.ok(!observed.includes(row), 'unwatched rows are no longer observed');
  const roomy = fakeRow(0, 3);
  FitRow.watch(roomy);
  assert.equal(roomy.dataset.fit, '0');
  FitRow.unwatch(roomy);
}));

test('a hidden or detached row keeps its level until it can be measured', () => withResizeObserver(() => {
  const hidden = fakeRow(2, 3);
  hidden.clientWidth = 0;
  FitRow.watch(hidden);
  assert.equal(hidden.dataset.fit, undefined);
  FitRow.unwatch(hidden);
  const detached = fakeRow(2, 3);
  detached.isConnected = false;
  FitRow.watch(detached);
  assert.equal(detached.dataset.fit, undefined);
  FitRow.unwatch(detached);
}));

test('the System tabs and the Deck segments are fit rows', () => {
  const html = read('../index.html');
  assert.match(html, /<div class="system-tabs" data-fit-levels="3">/);
  const scripts = [...html.matchAll(/<script src="js\/([\w-]+)\.js"/g)].map((m) => m[1]);
  assert.ok(scripts.indexOf('fit-row') > scripts.indexOf('i18n'), 'loaded after i18n');
  assert.ok(scripts.indexOf('fit-row') < scripts.indexOf('dashboard-layout'), 'loaded before the copies of the System tile are made');
  assert.match(read('../js/dashboard-layout.js'), /if \(window\.FitRow\) window\.FitRow\.watchAll\(clone\);/);
  assert.match(read('../js/deck-editor-behavior.js'), /seg\.dataset\.fitLevels = '2';/);
  const ed = read('../js/deck-editor.js');
  assert.match(ed, /if \(window\.FitRow\) backdrop\.stopFitRows = window\.FitRow\.watchWithin\(modal, '\.deck-ed-seg-text', 1\);/);
  assert.match(ed, /if \(m\.stopFitRows\) m\.stopFitRows\(\);\n    m\.remove\(\);/, 'closing the editor stops its watcher');
});

test('each fit level has its look in CSS', () => {
  const sys = read('../components/SystemPanel/SystemPanel.css');
  assert.match(sys, /\.system-tabs-left \{[^}]*flex-wrap: nowrap;/, 'the tabs never wrap into a column');
  assert.match(sys, /\.system-tabs\[data-fit="1"\] \.sys-tab:not\(\.active\) > span,/, 'level 1: only the open tab keeps its name');
  assert.match(sys, /\.system-tabs\[data-fit="3"\] \.sys-uptime \{ display: none; \}/, 'level 3: the uptime steps aside');
  const deck = read('../components/DeckPanel/DeckPanel.css');
  assert.match(deck, /\.deck-ed-modeseg\[data-fit="1"\] \{ grid-template-columns: repeat\(6, minmax\(0, 1fr\)\); \}/, 'behaviour: 3 + 2, even widths');
  assert.match(deck, /\.deck-ed-seg-text\[data-fit="1"\], \.deck-ed-seg-text\[data-fit="2"\] \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
});

test('a narrow System card keeps its head on one line', () => {
  const sys = read('../components/SystemPanel/SystemPanel.css');
  assert.match(sys, /\.stat-head > :first-child \{ flex: 0 0 auto; white-space: nowrap; \}/, 'the label never breaks under the value');
  assert.match(sys, /\.stat-head-right:has\(> \.stat-head-temp:not\(:empty\)\) \{ flex-shrink: 0; \}/, 'the temperature badge never covers the name');
  assert.match(sys, /@container stat-head \(max-width: 140px\) \{ \.stat-head-name \{ display: none; \} \}/);
});
