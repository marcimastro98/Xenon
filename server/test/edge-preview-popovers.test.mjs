import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Floating menus inside the Xeneon Edge preview.
//
// That mode turns <body> into a fixed 2560x720 stage, scales it to fit the
// browser window and hides whatever falls outside it (styles/edge-preview.css).
// A popover clamped to the WINDOW is therefore clamped to space that is not
// there: it lands in the letterbox and `overflow: hidden` cuts it off.
//
// Reported from the Deck's action picker — "part of the list displayed when you
// configure a key is outside the window. Top of the list is not visible." A
// 50-row menu lost 110px above the stage's top edge, measured in a browser.
//
// Two menus had the same fault and both are fixed: the shared dropdown panel
// (custom-select.js) and the Deck's profile popover (deck.js), which is portaled
// to the very <body> that becomes the stage.

const CS = readFileSync(new URL('../js/custom-select.js', import.meta.url), 'utf8');
const DECK = readFileSync(new URL('../js/deck.js', import.meta.url), 'utf8');
const EDGE_CSS = readFileSync(new URL('../styles/edge-preview.css', import.meta.url), 'utf8');

test('the preview really does clip — the premise of all of this', () => {
  // If either of these ever changes, the fixes below are solving a problem that
  // no longer exists and the reasoning needs revisiting.
  assert.match(EDGE_CSS, /html\.edge-preview body \{[\s\S]*?overflow: hidden;/,
    'the stage is what hides an overflowing menu');
  assert.match(EDGE_CSS, /html\.edge-preview body \{[\s\S]*?height: 720px;/,
    'and it is a fixed height, unrelated to the window');
});

test('the dropdown panel measures the stage, not the window', () => {
  const at = CS.indexOf('function bounds()');
  assert.ok(at > 0, 'the dropdown needs a notion of the box it must stay inside');
  const body = CS.slice(at, CS.indexOf('\n  function positionPanel', at));
  assert.match(body, /classList\.contains\('edge-preview'\)/);
  assert.match(body, /document\.body/, 'in that mode the body IS the stage');
  assert.match(body, /Math\.min\(vw, r\.right\)/, 'intersected with the window, never wider');
  assert.match(body, /Math\.min\(vh, r\.bottom\)/);
});

test('every clamp in the dropdown reads that box', () => {
  const at = CS.indexOf('function positionPanel()');
  const body = CS.slice(at, CS.indexOf('\n  function open()', at));
  // The old code clamped against window.innerWidth/innerHeight directly.
  assert.doesNotMatch(body, /window\.innerWidth|window\.innerHeight/,
    'positionPanel must go through bounds(), or the stage is bypassed again');
  assert.match(body, /const b = bounds\(\);/);
  // Top and bottom edges both come from the box.
  assert.match(body, /Math\.max\(b\.top \+ edge/);
  assert.match(body, /b\.top \+ b\.height - edge - h/);
});

test('the dropdown converts between layout and on-screen pixels', () => {
  // The stage is SCALED, so the trigger rect (on-screen) and scrollHeight
  // (layout) are different units. Mixing them silently mis-sizes the panel.
  const at = CS.indexOf('function positionPanel()');
  const body = CS.slice(at, CS.indexOf('\n  function open()', at));
  assert.match(body, /probe\.height \/ panel\.offsetHeight/, 'the ratio is measured, not read off a transform');
  assert.match(body, /panel\.scrollHeight \* scale/, 'the natural height becomes on-screen pixels');
  assert.match(body, /\(h \/ scale\) \+ 'px'/, 'and max-height goes back to layout pixels');
  // The self-correcting second pass has to divide by it too, or it undershoots
  // by exactly the scale factor and never lands.
  assert.match(body, /\(wantLeft - got\.left\) \/ scale/);
  assert.match(body, /\(wantTop - got\.top\) \/ scale/);
});

test('with no scaling the dropdown behaves exactly as before', () => {
  const at = CS.indexOf('function positionPanel()');
  const body = CS.slice(at, CS.indexOf('\n  function open()', at));
  // scale falls back to 1 on a zero-height measurement, so dividing is always safe
  // and is a no-op off the preview.
  assert.match(body, /panel\.offsetHeight > 0 \? \(probe\.height \/ panel\.offsetHeight\) \|\| 1 : 1/);
});

test('the Deck profile popover clamps to the stage as well', () => {
  const at = DECK.indexOf('function positionProfileMenu(');
  assert.ok(at > 0);
  const body = DECK.slice(at, DECK.indexOf('\n  }', at));
  assert.match(body, /classList\.contains\('edge-preview'\)/);
  assert.match(body, /roomW = stage \? stage\.offsetWidth : window\.innerWidth/);
  assert.match(body, /roomH = stage \? stage\.offsetHeight : window\.innerHeight/);
  // And the clamps must actually use them.
  assert.match(body, /Math\.min\(left, roomW - mw - margin\)/);
  assert.match(body, /top \+ mh > roomH - margin/);
  assert.ok(!/window\.innerHeight - margin/.test(body), 'the window height must no longer be the ceiling');
});

test('the popover still uses layout pixels, since it is portaled to that body', () => {
  const at = DECK.indexOf('function positionProfileMenu(');
  const body = DECK.slice(at, DECK.indexOf('\n  }', at));
  // offsetWidth/offsetHeight are layout units, matching the rect-divided-by-zoom
  // coordinates the function already worked in. Mixing in a visual rect here
  // would reintroduce the bug the zoom comment describes.
  assert.match(body, /__pageZoom/, 'the Edge zoom conversion stays');
  assert.match(body, /stage\.offsetWidth/);
});
