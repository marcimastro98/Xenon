import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The Timer widget's add row (label + duration) and its format hint sat on
// screen permanently. Reported from a Xeneon Edge — wide and only 720px tall —
// where that band is a third of the widget and the hint is two lines of 11px
// grey the panel cannot render legibly. Both halves are now on demand: the hint
// appears while the row has focus, and the whole row folds to a slim
// "+ New timer" strip that is remembered across restarts.

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const HTML = read('index.html');
const CSS = read('components', 'TimerPanel', 'TimerPanel.css');
const JS = read('js', 'timer.js');

test('the add section has both faces: the row body and the collapsed strip', () => {
  assert.match(HTML, /class="timer-add-section" data-timerf="add-section"/);
  assert.match(HTML, /data-timerf="add-strip"/);
  assert.match(HTML, /data-timerf="add-body"/);
  // The strip must say what it does — collapsing folds the way to add a timer
  // away, it must never hide it.
  assert.match(HTML, /data-i18n="timer_add_new"/);
});

test('the format hint text sits in a child element, not directly in the wrapper', () => {
  // The wrapper collapses with grid-template-rows: 0fr, and an anonymous grid
  // item made from a bare text node cannot take the min-height: 0 that needs —
  // the hint would keep its height and the space would never come back.
  assert.match(HTML, /<div class="timer-format-hint"><span data-i18n="timer_format_hint">/);
  assert.match(CSS, /\.timer-format-hint > \* \{\s*min-height: 0;/);
});

test('the hint is hidden until the add row has focus', () => {
  const block = CSS.slice(CSS.indexOf('.timer-format-hint {'));
  assert.match(block, /grid-template-rows: 0fr;/);
  assert.match(block, /opacity: 0;/);
  assert.match(CSS, /\.timer-add-row:focus-within ~ \.timer-format-hint/);
});

test('the collapsed state is driven by one attribute on the section', () => {
  assert.match(CSS, /\.timer-add-section\[data-collapsed="true"\] \.timer-add-body/);
  assert.match(CSS, /\.timer-add-section\[data-collapsed="true"\] \.timer-add-strip \{ display: flex; \}/);
  // Hidden, not merely transparent: an open row must never have a full-width
  // invisible button over it eating taps meant for the inputs.
  assert.match(CSS, /\.timer-add-strip \{\s*display: none;/);
});

test('timer.js reads, paints and persists the collapsed flag', () => {
  assert.match(JS, /function setTimerAddCollapsed\(/);
  assert.match(JS, /function applyTimerAddCollapsed\(/);
  assert.match(JS, /saveDashboardLayout\(\{ \.\.\.getDashboardLayout\(\), timerAddCollapsed: want \}/);
  // Painted on load, or a page that starts collapsed opens expanded.
  const load = JS.slice(JS.indexOf('function loadTimers('), JS.indexOf('function _hasRunningTimer('));
  assert.ok(load.includes('applyTimerAddCollapsed()'), 'loadTimers must paint the saved state');
});

test('Escape folds the row away and Enter still adds', () => {
  const fn = JS.slice(JS.indexOf('function onTimerInputKeydown('));
  assert.match(fn, /e\.key === 'Enter'[\s\S]*addTimerFromInput\(\)/);
  assert.match(fn, /e\.key === 'Escape'[\s\S]*setTimerAddCollapsed\(true\)/);
});

test('both settings normalizers carry timerAddCollapsed', () => {
  // The client normalizer and the server's copy are two separate lists, and a
  // field missing from the server's is silently dropped on save — the flag
  // would look like it worked until the next reload. It did, once.
  for (const file of ['js/settings.js', 'server.js']) {
    const src = read(...file.split('/'));
    assert.ok(src.includes('timerAddCollapsed: false'), `${file}: missing the default`);
    assert.ok(src.includes('layout.timerAddCollapsed = source.timerAddCollapsed === true;'), `${file}: missing the normalizer line`);
  }
});

test('a Timer copy is still cloned without the add section', () => {
  // Copies share one add row — the flag is global for that reason. The
  // strippers match on .timer-add-section, which the new wrapper still carries.
  const layout = read('js', 'dashboard-layout.js');
  assert.match(layout, /function stripTimerClone\(clone\) \{[\s\S]*\.timer-add-section/);
  assert.match(layout, /function stripAgendaClone\(clone\) \{[\s\S]*\.timer-add-section/);
  assert.match(HTML, /class="timer-add-section"/);
});

test('the new strings are translated in every language the app ships', () => {
  const src = read('js', 'i18n.js');
  for (const k of ['timer_add_new', 'timer_add_expand', 'timer_add_collapse']) {
    const n = (src.match(new RegExp(`["']?${k}["']?\\s*:`, 'g')) || []).length;
    assert.equal(n, 11, `${k} is defined ${n} times, expected 11 (one per language)`);
  }
});
