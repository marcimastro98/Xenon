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
test('the Edge, tablets and desktops keep the PHONE chrome off', () => {
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
      v.width + 'x' + v.height + ' should not get the phone chrome');
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

// ── The tablet band ──────────────────────────────────────────────────────────
// It exists because it measured WORSE than the phone: at 768x1024 against a
// real dashboard, 30 elements were clipped by an ancestor with `overflow:
// hidden`, against 9 at 390px. Nothing adapted between the phone threshold and
// the desktop one, so a 32px grid column just squeezed every widget.

test('tablets stack in two columns instead of being squeezed', () => {
  const TABLETS = [
    { width: 768, height: 1024 },   // iPad
    { width: 820, height: 1180 },   // iPad Air portrait
    { width: 834, height: 1112 },   // iPad Pro 10.5
    { width: 1024, height: 768 },   // iPad landscape
    { width: 1080, height: 810 },
  ];
  for (const v of TABLETS) {
    assert.equal(pv.stackMode({ ...v, preference: 'auto' }), 'tablet',
      v.width + 'x' + v.height + ' should stack in two columns');
  }
  assert.ok(pv.TABLET_MAX_W > pv.PHONE_MAX_W, 'the two bands must not overlap or invert');
});

test('a DISPLAY mounted vertically is not a tablet held in portrait', () => {
  // A Xeneon Edge stood on its end is 720x2560 — inside the tablet width band,
  // and its owner built a layout for exactly that shape. Restacking it into two
  // columns would throw that away. The ratio is what separates them: 3.6
  // against about 1.4 for every real tablet.
  assert.equal(pv.stackMode({ width: 720, height: 2560, preference: 'auto' }), 'off');
  assert.equal(pv.stackMode({ width: 1080, height: 3840, preference: 'auto' }), 'off');
  // …and a tablet in portrait is nowhere near that, so it still stacks.
  assert.equal(pv.stackMode({ width: 820, height: 1180, preference: 'auto' }), 'tablet');
  assert.ok(pv.TALL_DISPLAY_RATIO > 1180 / 820, 'must not claim an iPad in portrait');
  assert.ok(pv.TALL_DISPLAY_RATIO < 2560 / 720, 'must claim a vertical Edge');
});

test('a phone on its side is answered phone, never tablet', () => {
  // Every one of these is inside the tablet WIDTH band, and the order of the
  // checks is the only thing that keeps them out of it.
  for (const v of [{ width: 932, height: 430 }, { width: 844, height: 390 }, { width: 915, height: 412 }]) {
    assert.equal(pv.stackMode({ ...v, preference: 'auto' }), 'phone',
      v.width + 'x' + v.height + ' is a phone lying down');
  }
});

test('desktops are left alone entirely', () => {
  for (const v of [{ width: 1280, height: 800 }, { width: 1920, height: 1080 }, { width: 2560, height: 720 }]) {
    assert.equal(pv.stackMode({ ...v, preference: 'auto' }), 'off', v.width + 'x' + v.height);
  }
});

test('the preference and the embed rule still beat every measurement', () => {
  assert.equal(pv.stackMode({ width: 768, height: 1024, preference: 'off' }), 'off');
  assert.equal(pv.stackMode({ width: 2560, height: 1440, preference: 'on' }), 'phone');
  for (const pref of ['auto', 'on', 'off']) {
    assert.equal(pv.stackMode({ width: 768, height: 1024, preference: pref, embedded: true }), 'off', pref);
  }
});

test('a width with no height in the tablet band takes the roomier answer', () => {
  // Without a height a phone on its side and a small tablet are the same
  // number, and the safe reading of a bare width there is two columns, never
  // the phone's compact chrome and thumb dock on an iPad.
  assert.equal(pv.stackMode({ width: 900, preference: 'auto' }), 'tablet');
  assert.equal(pv.stackMode({ width: 390, preference: 'auto' }), 'phone', 'the phone width is unambiguous');
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

// THE bug this was reported for. `y` is a grid ROW, so tiles that sit visibly
// side by side can differ in it — and a plain sort by (y, x) then reads a
// two-row nudge as a new line. Measured on a real dashboard: three tiles filled
// one band at (x0,y0,h24), (x8,y2,h22) and (x16,y0,h24), 70px of offset that
// nobody looking at the screen would call a row, and the MIDDLE column sorted
// last. The user reads left, middle, right and got left, right, middle.
test('tiles that share a band read left to right, whatever their row', () => {
  const tiles = [
    { x: 0, y: 0, h: 24 },    // left
    { x: 16, y: 0, h: 24 },   // right
    { x: 8, y: 2, h: 22 },    // middle, nudged down two rows
  ];
  assert.deepEqual(pv.readingOrder(tiles), [0, 2, 1], 'left, middle, right');
});

test('a tile that starts halfway down a tall neighbour is below it, not beside it', () => {
  // The other half of the rule: banding must not swallow a whole column just
  // because one tile is tall. A short tile near the BOTTOM of a tall one is a
  // new band, and comes after everything in the first.
  const tiles = [
    { x: 0, y: 0, h: 30 },    // tall left column
    { x: 12, y: 0, h: 10 },   // beside its top
    { x: 12, y: 24, h: 6 },   // far down its side
  ];
  assert.deepEqual(pv.readingOrder(tiles), [0, 1, 2]);
});

test('banding is relative to the band, so short and tall rows read the same', () => {
  // Two rows of short tiles. A fixed row tolerance would merge them; a
  // tolerance taken from the band's own first tile does not.
  const tiles = [
    { x: 0, y: 0, h: 6 }, { x: 12, y: 0, h: 6 },
    { x: 0, y: 6, h: 6 }, { x: 12, y: 6, h: 6 },
  ];
  assert.deepEqual(pv.readingOrder(tiles), [0, 1, 2, 3]);
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
  // so strip them before looking for calls. The `[^:]` guard is what keeps the
  // strip from eating the rest of a line at the `//` of a URL — the file holds
  // the SVG namespace, and without the guard everything after it disappeared
  // and this test passed for the wrong reason.
  const code = raw.replace(/(^|[^:])\/\/.*$/gm, '$1');
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
  // `.is-stacked`, not `.is-phone`: the tiles leave the grid the same way in
  // both sizes, and only the column count and the chrome differ.
  const SEL = '.is-stacked .dashboard.grid-stack > .grid-stack-item';
  const at = bare.indexOf(SEL);
  assert.notEqual(at, -1, 'the item rule was not located — did the scope class change?');
  const itemRule = bare.slice(at);
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

// A mobile browser floats its own control over the bottom-RIGHT corner of the
// page, and no page-level rule can win that argument. Reported on Android 16
// over Tailscale: the floating button covered the dock's tail, which was the
// Settings forwarder — and phone view hides the topbar's Settings button, so
// there was no second route to the panel at all.
//
// So the corner is conceded to the pager, which is the one dock control the
// user can reach another way (the pages swipe). Pinned in both files because
// right-aligning the buttons is the natural-looking thing to "tidy" this into,
// and the damage is invisible on every screen that has no floating chrome.
test('the dock concedes the bottom-right corner to the pager, not to the actions', () => {
  const js = fs.readFileSync(path.join(HERE, '..', 'js', 'phone-view.js'), 'utf8');
  const appendAt = js.indexOf('dock.append(acts, pages)');
  assert.notEqual(appendAt, -1,
    'the actions must be appended before the pager, so the pager takes the right edge');

  const css = fs.readFileSync(path.join(HERE, '..', 'components', 'PhoneView', 'PhoneView.css'), 'utf8');
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const ruleFor = (sel) => {
    const at = bare.indexOf(sel + ' {');
    assert.notEqual(at, -1, sel + ' rule was not located — did the class change?');
    const rest = bare.slice(at);
    return rest.slice(0, rest.indexOf('}'));
  };
  // The pager, not the actions, is what auto-margin pushes against the right
  // edge — and the actions stay anchored left whether or not the pager shows,
  // so a single-page dashboard leaves that corner empty rather than moving
  // Settings into it.
  assert.match(ruleFor('.ph-pages'), /margin-left:\s*auto/,
    'the pager must be the control anchored to the right edge');
  assert.equal(/margin-left:\s*auto/.test(ruleFor('.ph-acts')), false,
    'the dock actions must not be pushed into the corner a browser floats over');
});
