import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pv = require('../js/phone-view.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── When the stacked view takes over ─────────────────────────────────────────

test('every phone in portrait gets the stacked view', () => {
  // Real CSS widths: iPhone SE, 13 mini, 15, 15 Pro Max, a mid Android, a fold.
  for (const w of [320, 360, 375, 390, 393, 412, 430, 344]) {
    assert.equal(pv.shouldUsePhoneView({ width: w, preference: 'auto' }), true, w + 'px should stack');
  }
});

// The threshold exists because a 24-column grid needs ~22px per column to stay
// legible. Raising it past a Xeneon Edge mounted vertically (720) would restack
// the layout somebody built for that screen.
test('the Edge, tablets and desktops keep the grid', () => {
  // Real viewports, both orientations. The Xeneon Edge is the one that matters
  // most: 2560x720 is short and very wide, which is exactly the shape the
  // landscape rule below must not claim.
  const KEEP = [
    { width: 2560, height: 720 },   // Xeneon Edge
    { width: 720, height: 2560 },   // …mounted vertically
    { width: 820, height: 1180 },   // iPad portrait
    { width: 1180, height: 820 },   // iPad landscape
    { width: 1024, height: 768 },
    { width: 1280, height: 800 },
    { width: 1920, height: 1080 },
    { width: 1920, height: 600 },   // a deliberately short desktop window
  ];
  for (const v of KEEP) {
    assert.equal(pv.shouldUsePhoneView({ ...v, preference: 'auto' }), false,
      v.width + 'x' + v.height + ' should keep the grid');
  }
  assert.ok(pv.PHONE_MAX_W < 720, 'the threshold must stay clear of a vertical Xeneon Edge');
  assert.ok(pv.PHONE_MAX_W >= 430, 'the threshold must cover the widest phone in portrait');
  assert.ok(pv.PHONE_MAX_H < 720, 'the height bound must stay clear of a horizontal Xeneon Edge');
  assert.ok(pv.PHONE_LANDSCAPE_MAX_W < 2560, 'the width bound must stay clear of the Edge');
});

// Rotating a phone does not turn it into a tablet. The first version of this
// left landscape on the grid, reasoning that ~930px is cramped but readable —
// true horizontally, and beside the point: ~430px of height clips every tile
// and puts the chrome on top of the rest. Reported from a real iPhone.
test('a phone on its side stacks too, and a short desktop window does not', () => {
  const PHONES = [
    { width: 932, height: 430 },   // iPhone 15 Pro Max
    { width: 844, height: 390 },   // iPhone 13/14
    { width: 667, height: 375 },   // iPhone SE
    { width: 915, height: 412 },   // a mid Android
  ];
  for (const v of PHONES) {
    assert.equal(pv.shouldUsePhoneView({ ...v, preference: 'auto' }), true,
      v.width + 'x' + v.height + ' should stack');
  }
  // Same short height, desktop width → the grid is still the better answer.
  assert.equal(pv.shouldUsePhoneView({ width: 1400, height: 430, preference: 'auto' }), false);
});

// A caller that measured only the width must still get the portrait answer,
// never a guess about the other dimension.
test('a missing height decides on width alone', () => {
  assert.equal(pv.shouldUsePhoneView({ width: 390, preference: 'auto' }), true);
  assert.equal(pv.shouldUsePhoneView({ width: 932, preference: 'auto' }), false);
  for (const h of [0, -5, NaN, 'short', null, undefined]) {
    assert.equal(pv.shouldUsePhoneView({ width: 932, height: h, preference: 'auto' }), false, String(h));
  }
});

test('an explicit preference beats the measurement in both directions', () => {
  assert.equal(pv.shouldUsePhoneView({ width: 2560, preference: 'on' }), true);
  assert.equal(pv.shouldUsePhoneView({ width: 390, preference: 'off' }), false);
  // …and nothing else counts as a preference.
  assert.equal(pv.shouldUsePhoneView({ width: 390, preference: 'yes' }), true);
  assert.equal(pv.shouldUsePhoneView({ width: 2560, preference: 'yes' }), false);
});

// A `?panel=…` iCUE embed and the Edge preview stage are both narrow for
// reasons that have nothing to do with a phone, and both already have a layout.
// This beats even an explicit preference — that setting is about this device's
// dashboard, not about an embed inside it.
test('an embedded surface is never restacked, whatever the width or preference', () => {
  for (const pref of ['auto', 'on', 'off']) {
    assert.equal(pv.shouldUsePhoneView({ width: 380, preference: pref, embedded: true }), false, pref);
    assert.equal(pv.shouldUsePhoneView({ width: 2560, preference: pref, embedded: true }), false, pref);
  }
  // …and the same viewport without the embed flag does stack.
  assert.equal(pv.shouldUsePhoneView({ width: 380, preference: 'auto', embedded: false }), true);
});

test('an unmeasurable viewport never silently restacks the dashboard', () => {
  for (const input of [{}, null, undefined, { width: 0 }, { width: -5 }, { width: NaN }, { width: 'wide' }]) {
    assert.equal(pv.shouldUsePhoneView(input), false, JSON.stringify(input));
  }
});

// ── Reading order ────────────────────────────────────────────────────────────

// The stacked view's whole claim is "the same order you see on your PC", so the
// permutation is the thing to pin.
test('tiles stack row by row, left to right', () => {
  //  ┌───────┬───────┐
  //  │  A    │  B    │   A=(0,0) B=(12,0)
  //  ├───────┴───────┤
  //  │       C       │   C=(0,8)
  const tiles = [
    { x: 12, y: 0 },   // B, first in DOM
    { x: 0, y: 8 },    // C
    { x: 0, y: 0 },    // A
  ];
  assert.deepEqual(pv.readingOrder(tiles), [2, 0, 1], 'A, B, C');
});

test('a taller tile beside shorter ones does not jump the queue', () => {
  // A tall left column next to two stacked tiles: the tall one starts on row 0
  // and comes first; the lower right tile comes last even though it is short.
  const tiles = [
    { x: 0, y: 0 },    // tall left
    { x: 12, y: 0 },   // top right
    { x: 12, y: 6 },   // bottom right
  ];
  assert.deepEqual(pv.readingOrder(tiles), [0, 1, 2]);
});

test('ties keep their original order, so the view cannot flicker', () => {
  // Two tiles can only share coordinates mid-heal (dashboard-layout resolves
  // overlaps on the next pass). A stable sort means the stacked view does not
  // shuffle between two equally valid answers while that happens.
  const tiles = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
  assert.deepEqual(pv.readingOrder(tiles), [0, 1, 2]);
  assert.deepEqual(pv.readingOrder(tiles), [0, 1, 2]);
});

test('missing or junk coordinates are treated as the origin, never dropped', () => {
  const out = pv.readingOrder([{ x: 4, y: 4 }, {}, { x: null, y: undefined }, null, { x: 'a', y: 'b' }]);
  assert.equal(out.length, 5, 'a tile with unreadable coordinates must still be shown');
  assert.deepEqual([...out].sort((a, b) => a - b), [0, 1, 2, 3, 4], 'the permutation must be complete');
  assert.equal(out[out.length - 1], 0, 'the one real tile sorts after the origin group');
});

test('empty and non-array input yield an empty order', () => {
  assert.deepEqual(pv.readingOrder([]), []);
  assert.deepEqual(pv.readingOrder(null), []);
  assert.deepEqual(pv.readingOrder('nope'), []);
});

// ── Contract with the rest of the app ────────────────────────────────────────

// The stacked view works by overriding GridStack's positioning in CSS. If it
// ever reached for GridStack's own column API instead, changing the column count
// would rewrite every tile's coordinates and fire `change`, which
// dashboard-grid.js serializes and SAVES — opening the dashboard on a phone
// would silently rewrite the layout built on the PC.
test('the phone view never touches the grid engine', () => {
  const raw = fs.readFileSync(path.join(HERE, '..', 'js', 'phone-view.js'), 'utf8');
  // Comments explain WHY the grid engine is off limits and name it repeatedly,
  // so strip them before looking for calls. Safe here because the file contains
  // no `://`, which is the one thing a naive `//` strip would mangle.
  assert.equal(raw.includes('://'), false, 'a URL in this file would break the comment strip below');
  const code = raw.replace(/\/\/.*$/gm, '');
  for (const forbidden of ['GridStack', '.column(', 'saveDashboardLayout', 'serialize(', 'batchUpdate']) {
    assert.equal(code.includes(forbidden), false,
      'phone-view.js must not call ' + forbidden + ' — presentation only');
  }
});

// The CSS must not collapse a tile that is hidden because it is the inactive
// member of a tab group; overriding `display` on the item would reveal it.
test('the stacking rules leave `display` on tiles alone', () => {
  const css = fs.readFileSync(path.join(HERE, '..', 'components', 'PhoneView', 'PhoneView.css'), 'utf8');
  // Strip comments first: they explain the rules by quoting CSS, braces and all,
  // so a naive "up to the next }" lands inside a comment.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const itemRule = bare.slice(bare.indexOf('.is-phone .dashboard.grid-stack > .grid-stack-item'));
  const block = itemRule.slice(0, itemRule.indexOf('}'));
  assert.ok(block.includes('position: static'), 'the item rule was not located');
  assert.equal(/(^|[;{\s])display\s*:/.test(block), false,
    'setting display on a grid item would un-hide inactive tab-group members');

  // A stacked tile needs a DEFINITE height, not `height:auto` + `min-height`.
  // Every widget is built on `.grid-stack-item-content > .panel { height: 100% }`,
  // and a percentage height does not resolve against an auto-height parent even
  // when min-height has stretched it — measured: the media tile rendered its
  // title and nothing else. Pinned because the auto-height version looks more
  // natural and is the obvious thing to "simplify" this back into.
  assert.match(block, /(^|[;{\s])height\s*:\s*clamp\(/,
    'the item must get a definite height, or every height:100% chain inside it collapses');
  assert.equal(/min-height\s*:\s*clamp\(/.test(block), false,
    'min-height does not make percentages resolve — that was the bug');

  // And the dock must clear the home-indicator area, or the last control sits
  // under the system gesture bar on every modern phone.
  assert.ok(css.includes('env(safe-area-inset-bottom)'), 'the dock must respect the safe area');
});
