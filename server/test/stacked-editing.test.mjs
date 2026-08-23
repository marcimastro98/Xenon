// Editing the dashboard while the tiles are stacked.
//
// A stacked view draws the tiles in reading order, not at their grid
// coordinates. The old rule was to refuse the whole editor there, which was
// right when "stacked" only ever meant "a phone". Since v4.11.5 it does not:
// Settings → Tile layout lets someone put a MONITOR into a single column, and
// on that screen the refusal removed adding, hiding and moving a widget — none
// of which is geometry — leaving a dashboard that looked like it could not be
// edited at all. Reported on Discord.
//
// So the two halves are separated. Geometry (drag, corner resize) is refused
// wherever the tiles are not at their coordinates. Everything else stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { gridStaticFor } = require('../js/dashboard-grid.js');

const CSS = readFileSync(new URL('../components/PhoneView/PhoneView.css', import.meta.url), 'utf8');
const GRID = readFileSync(new URL('../js/dashboard-grid.js', import.meta.url), 'utf8');
const PHONE = readFileSync(new URL('../js/phone-view.js', import.meta.url), 'utf8');

// ── The rule ─────────────────────────────────────────────────────────────────

// Refused at the source rather than by hiding the handles, because the drag
// handle is the tile CONTENT itself (`draggable.handle` at mount) — a hidden
// overlay would not have stopped a drag starting on the tile body.
test('the grid is draggable only while editing AND unstacked', () => {
  assert.equal(gridStaticFor(true, false), false, 'editing on the grid: draggable');
  assert.equal(gridStaticFor(true, true), true, 'editing while stacked: static');
  assert.equal(gridStaticFor(false, false), true, 'not editing: static');
  assert.equal(gridStaticFor(false, true), true);
});

test('a missing stacked answer is treated as unstacked, not as a crash', () => {
  assert.equal(gridStaticFor(true, undefined), false);
  assert.equal(gridStaticFor(true, null), false);
});

// ── Wiring ───────────────────────────────────────────────────────────────────

// The mode can change while the editor is already open — a rotation, or the
// Tile layout switch in Settings — and setEditing() is not called again for
// that. Without the re-apply the grid would keep whatever static state it had
// when the editor opened.
test('the stacked view re-applies the rule when it goes on and off', () => {
  assert.match(GRID, /window\.DashboardGrid = \{[^}]*syncStatic/, 'DashboardGrid must expose syncStatic');
  assert.match(GRID, /staticGrid: shouldGridBeStatic\(\)/, 'a freshly mounted grid obeys the rule too');
  const enable = PHONE.slice(PHONE.indexOf('function enable('), PHONE.indexOf('function disable('));
  assert.match(enable, /syncGridStatic\(\)/, 'enable() must re-apply');
  const disable = PHONE.slice(PHONE.indexOf('function disable('), PHONE.indexOf('function sync('));
  assert.match(disable, /syncGridStatic\(\)/, 'disable() must re-apply');
  // …and it must survive DashboardGrid not being there at all.
  assert.match(PHONE, /function syncGridStatic\(\)[\s\S]{0,400}catch/);
});

// ── What the stacked view hides, and what it must not ────────────────────────

// Comments are stripped first: the selector of a rule is everything between the
// previous `}` and the `{`, so a documented rule carries its own comment into
// the first selector and it stops matching by prefix.
const CSS_RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

function hiddenFor(selectorPrefix) {
  // Every rule body that hides something, keyed by the selectors it applies to.
  const out = new Set();
  for (const m of CSS_RULES.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/display:\s*none/.test(m[2])) continue;
    for (const sel of m[1].split(',')) {
      const s = sel.trim();
      if (s.startsWith(selectorPrefix)) out.add(s.slice(selectorPrefix.length).trim());
    }
  }
  return out;
}

// The regression this file exists for: these are the editor's non-geometric
// half, and hiding them is what made one column look uneditable.
test('a stacked view no longer hides the non-geometric editor controls', () => {
  const stacked = hiddenFor('.is-stacked');
  for (const sel of ['.layout-controls', '.layout-fab', '.layout-dock', '.pager-page-btn']) {
    assert.ok(!stacked.has(sel), `.is-stacked must not hide ${sel}`);
  }
});

test('a stacked view still hides the drag surface', () => {
  assert.ok(hiddenFor('.is-stacked').has('.gs-edit-overlay'));
});

// A phone is a separate judgement and keeps the old answer: a 24-column layout
// is not a thumb job, and the controls are tap targets on an already narrow tile.
test('a phone still keeps the editor out of reach', () => {
  const phone = hiddenFor('.is-phone');
  for (const sel of ['.layout-controls', '.layout-fab', '.pager-page-btn']) {
    assert.ok(phone.has(sel), `.is-phone must still hide ${sel}`);
  }
  // The button that OPENS the editor lives outside .layout-controls, so hiding
  // only the controls would leave it in the corner offering an editor that
  // shows nothing — the bug the original rule already had to fix once.
  assert.ok(phone.has('.layout-fab'));
});

// The dock is where a widget is actually added, and nothing hides it in either
// view. Pinned because "add a widget" is the specific thing that was reported
// missing, and it arrives through the dock rather than through a tile control.
test('the widget dock is never hidden by the stacked view', () => {
  for (const prefix of ['.is-stacked', '.is-phone', '.is-tablet']) {
    assert.ok(!hiddenFor(prefix).has('.layout-dock'), `${prefix} must not hide the dock`);
  }
});
