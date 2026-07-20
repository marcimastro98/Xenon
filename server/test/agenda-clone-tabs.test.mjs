import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Regression guard: the sub-tabs of a DUPLICATED Agenda tile did nothing when
// tapped, and only caught up after a page reload.
//
// stripCloneFor() removes every id from a copy, but the Agenda's tab bar kept its
// stock inline `onclick="switchCalendarTaskView(...)"`, and that handler resolves
// its panes and buttons with document.getElementById. On a copy those ids exist
// only on the PRIMARY tile, so a tap switched an Agenda that was off screen and
// persisted the choice; the copy caught up on the next reload, when it is
// re-cloned from the primary. The System tile never had the bug because
// wireSystemCloneTabs strips the inline handler and binds a clone-local one that
// matches panes by class. wireAgendaCloneTabs is the Agenda's equivalent, and it
// matches on data-calpane / data-caltab because the panes have no other hook.
//
// There is no DOM harness in this suite, so these are structural assertions on
// the two files that have to agree. What they catch is the realistic regression:
// one of the data hooks being dropped or renamed, which would silently return the
// copy's tab bar to doing nothing at all.

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const LAYOUT = readFileSync(join(__dirname, '..', 'js', 'dashboard-layout.js'), 'utf8');

const VIEWS = ['calendar', 'tasks', 'timer', 'notes'];

function attrValues(src, attr) {
  return [...src.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))].map(m => m[1]);
}

test('every Agenda tab button carries a data-caltab hook', () => {
  assert.deepEqual(attrValues(HTML, 'data-caltab').sort(), [...VIEWS].sort());
});

test('every Agenda pane carries a matching data-calpane hook', () => {
  // A tab whose pane hook is missing is dropped from a copy's bar by
  // wireAgendaCloneTabs, so a mismatch here silently removes a tab.
  assert.deepEqual(attrValues(HTML, 'data-calpane').sort(), [...VIEWS].sort());
});

test('the tab bar and the panes still agree on the class names the wiring queries', () => {
  for (const view of VIEWS) {
    assert.match(HTML, new RegExp(`class="cal-task-btn[^"]*"[^>]*data-caltab="${view}"`),
      `the ${view} tab must keep the .cal-task-btn class`);
    assert.match(HTML, new RegExp(`class="cal-pane"[^>]*data-calpane="${view}"`),
      `the ${view} pane must keep the .cal-pane class`);
  }
  assert.match(HTML, /class="cal-task-toggle"/, 'the bar class is what hides a one-tab bar');
});

test('an Agenda copy re-wires its tab bar instead of inheriting the id-based handler', () => {
  assert.match(LAYOUT, /function stripAgendaClone\(clone\)[\s\S]*?wireAgendaCloneTabs\(clone\);[\s\S]*?\n}/,
    'stripAgendaClone must call wireAgendaCloneTabs');
  const fn = LAYOUT.slice(LAYOUT.indexOf('function wireAgendaCloneTabs'));
  assert.match(fn, /removeAttribute\('onclick'\)/,
    'the stock inline handler targets the primary by id and must be removed from a copy');
  assert.match(fn, /dataset\.calpane/, 'panes must be matched by data-calpane, not by id');
  assert.doesNotMatch(fn.slice(0, fn.indexOf('\n}')), /getElementById/,
    'a clone-local handler must never resolve anything by id');
});

test('the primary handler is scoped to one tile instead of resolving by id', () => {
  // getElementById binds to whichever agenda atom is first in the document, not
  // the one the user pressed. That is wrong for a copy (no ids at all) and wrong
  // during a pager rebuild, when every tile is parked in the hidden #widget-pool
  // and a stale atom can win the lookup. Both failures look identical to the
  // user: the click persists, but nothing moves until the next reload.
  const TASKS = readFileSync(join(__dirname, '..', 'js', 'tasks.js'), 'utf8');
  const start = TASKS.indexOf('function switchCalendarTaskView');
  assert.notEqual(start, -1);
  const fn = TASKS.slice(start, TASKS.indexOf('\n}', start));
  assert.doesNotMatch(fn, /getElementById/,
    'switchCalendarTaskView must resolve within its own tile, not by id');
  assert.match(fn, /agendaScopeFor\(from\)/, 'the scope must come from the pressed button');
  assert.match(TASKS, /function agendaScopeFor/);
  assert.match(TASKS, /#widget-pool/,
    'the programmatic path must prefer an on-page Agenda over a pooled one');

  for (const view of VIEWS) {
    assert.match(HTML, new RegExp(`switchCalendarTaskView\\('${view}', \\{ from: this \\}\\)`),
      `the ${view} tab must hand its own element to the handler`);
  }
});

test('the System tile keeps the equivalent wiring it has always had', () => {
  // Pinned because it is the reference the Agenda fix mirrors: if this one is
  // ever reverted to inline handlers, System copies break the same way.
  assert.match(LAYOUT, /function wireSystemCloneTabs\(clone\)/);
  const fn = LAYOUT.slice(LAYOUT.indexOf('function wireSystemCloneTabs'));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /removeAttribute\('onclick'\)/);
});
