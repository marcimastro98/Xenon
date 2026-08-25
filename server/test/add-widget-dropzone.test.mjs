// The "+" drop-zone getting out of the way while you move or resize a tile.
//
// refreshPageAddAffordances sizes the "+" to cover the page's whole free area,
// and it is a real button on top of the grid — measured in the running dashboard
// at 614x794 with pointer-events:auto, the topmost element over every empty
// cell. Which is right when you want to add a widget, and wrong for the entire
// length of a drag or a resize: the gesture ends over the "+", and the click
// that follows a release lands on it and opens the palette. Reported as "the +
// panel gets in the way" of resizing and rearranging.
//
// It stands down for the length of the gesture and nothing else changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const GRID = readFileSync(new URL('../js/dashboard-grid.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../components/DashboardGrid/DashboardGrid.css', import.meta.url), 'utf8');

// ── The rule ─────────────────────────────────────────────────────────────────

test('the drop-zone stops taking the pointer while a tile is being handled', () => {
  const rule = CSS.slice(CSS.indexOf('body.gs-manipulating .page-add-widget'));
  const body = rule.slice(0, rule.indexOf('}'));
  assert.match(body, /pointer-events:\s*none/, 'the whole point: give the pointer back');
  // Dimmed, not hidden. A target that vanishes under the cursor reads as a
  // glitch, and it is still where you are dragging toward.
  assert.match(body, /opacity:\s*0?\.\d+/);
  assert.ok(!/display:\s*none/.test(body), 'hiding it outright would be a flicker, not a fix');
});

test('every gesture that moves a tile raises the class, and every end drops it', () => {
  for (const evt of ['dragstart', 'resizestart']) {
    assert.match(GRID, new RegExp(`grid\\.on\\('${evt}'[^\\n]*manipulating\\(true\\)`), `${evt} must raise it`);
  }
  assert.match(GRID, /grid\.on\('resizestop'[^\n]*manipulating\(false\)/);
  // dragstop already had a handler doing merge-on-drop, so the clear lives
  // inside it rather than in a second registration — see the next test for why
  // a second registration would be a bug rather than a duplicate.
  const stop = GRID.slice(GRID.indexOf("grid.on('dragstop'"));
  assert.match(stop.slice(0, stop.indexOf('\n  });')), /manipulating\(false\)/);
});

// ── The trap this sits on ────────────────────────────────────────────────────

// GridStack's on() is `this._eventRegister[e] = t` — ONE handler per event name,
// last registration wins, silently. So two `grid.on('change')` calls would not
// both run: the second would replace the first and the first's work would simply
// stop happening, with nothing to see. Found the hard way while verifying this
// change: a browser probe that listened for 'resizestart' replaced the app's own
// handler and made a working fix look broken.
test('no grid event is registered twice, because the second would replace the first', () => {
  const seen = new Map();
  for (const m of GRID.matchAll(/grid\.on\('([a-z]+)'/g)) {
    seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  }
  const doubled = [...seen].filter(([, n]) => n > 1).map(([e, n]) => `${e} x${n}`);
  assert.deepEqual(doubled, [], `GridStack keeps one handler per event; these would be lost: ${doubled.join(', ')}`);
  // …and the ones this change depends on are actually there.
  for (const evt of ['dragstart', 'resizestart', 'resizestop', 'dragstop']) {
    assert.ok(seen.has(evt), `${evt} must be registered`);
  }
});

// The class toggle must never run inside the active resize loop: that file's own
// note records that calling grid getters per tick is what left drag-resize
// stuck. start/stop are one-shot, so they are safe; 'resize' is not subscribed.
test('the class is toggled on the one-shot events, never per frame', () => {
  assert.ok(!/grid\.on\('resize'/.test(GRID), "the per-tick 'resize' event stays unsubscribed");
});

// A gesture must not be able to leave the "+" inert for good — that would break
// adding a widget entirely, which is worse than the problem being fixed.
test('the class is only ever raised by a start and dropped by an end', () => {
  const raises = (GRID.match(/manipulating\(true\)/g) || []).length;
  const drops = (GRID.match(/manipulating\(false\)/g) || []).length;
  assert.equal(raises, 2, 'exactly the two gesture starts');
  assert.equal(drops, 2, 'and both of their ends');
});

// The toggle touches document.body from inside a drag callback; if it could
// throw it would break the gesture it is decorating.
test('a failure in the toggle cannot break the gesture', () => {
  const fn = GRID.slice(GRID.indexOf('const manipulating ='));
  assert.match(fn.slice(0, fn.indexOf('\n  };')), /try \{[\s\S]*\} catch/);
});
