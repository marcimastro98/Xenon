import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const N = require('../js/island-notch.js');

// A 600px-wide tile item with a 7px gutter and 18px corners; the pill sits in
// its middle, 44px tall, ending 46px below the item's top.
const base = { width: 600, margin: 7, radius: 18, pill: { left: 200, right: 400, bottom: 46, height: 44 } };

test('geometry cuts one ring wider than the island and starts the content under it', () => {
  const g = N.geometry(base);
  assert.equal(g.left, 200 - N.GAP);
  assert.equal(g.right, 400 + N.GAP);
  assert.equal(g.bottom, 46 + N.GAP);
  assert.equal(g.inset, 46 + N.GAP - 7);
  assert.equal(g.openLeft, false);
  assert.equal(g.openRight, false);
  assert.equal(g.cornerR, 44 / 2 + N.GAP);
});

test('geometry is null when the island does not sit on the tile', () => {
  assert.equal(N.geometry({ ...base, pill: { ...base.pill, left: 700, right: 900 } }), null);
  assert.equal(N.geometry({ ...base, pill: { ...base.pill, bottom: -10 } }), null);
  assert.equal(N.geometry({ ...base, pill: { left: 590, right: 700, bottom: 46, height: 44 } }), null); // under 12px of overlap
  assert.equal(N.geometry(null), null);
});

test('a cutout that reaches the tile corner takes the whole corner', () => {
  const g = N.geometry({ ...base, pill: { ...base.pill, left: 10 } });
  assert.equal(g.openLeft, true);
  assert.equal(g.shoulderL, 0);
  assert.ok(g.left < 0);
  assert.equal(g.openRight, false);
});

test('clipPath keeps one command list, so cutouts can animate into each other', () => {
  const shape = (p) => p.replace(/-?\d+(\.\d+)?/g, '#');
  const g = N.geometry(base);
  const open = N.geometry({ ...base, pill: { ...base.pill, left: 10, right: 595 } });
  assert.equal(shape(N.clipPath(g)), shape(N.clipPath(N.collapsed(g))));
  assert.equal(shape(N.clipPath(g)), shape(N.clipPath(open)));
});

test('collapsed shrinks the cutout to its centre at the tile top', () => {
  const g = N.geometry(base);
  const c = N.collapsed(g);
  assert.equal(c.left, c.right);
  assert.equal(c.left, (g.left + g.right) / 2);
  assert.equal(c.bottom, base.margin);
  assert.equal(N.edgePath(c, 1).split(' ').length, N.edgePath(g, 1).split(' ').length);
});

// A glass tile under the island takes the cutout on its surfaces, not on the
// item (an ancestor clip-path is the backdrop root and the blur saw nothing).
// The surfaces live in the content box, which starts `margin` inside the item,
// so the same cutout has to come out shifted by exactly that much.
test('surfaceClipPath is the item cutout moved into the content box', () => {
  const nums = (p) => p.match(/-?\d+(\.\d+)?/g).map(Number);
  const g = N.geometry(base);
  const item = nums(N.clipPath(g));
  const surface = nums(N.surfaceClipPath(g));
  assert.equal(surface.length, item.length);
  // The tile's top edge: item y = margin, surface y = 0.
  assert.match(N.surfaceClipPath(g), / V 0 A /);
  // The cutout's left wall and floor move by the gutter on both axes.
  assert.ok(N.surfaceClipPath(g).includes(`V ${g.bottom - base.margin - g.cornerR} `));
  assert.ok(N.surfaceClipPath(g).includes(` ${g.left - base.margin} ${base.margin - base.margin + g.shoulderL}`));
});

test('the item clip is unchanged by the surface variant', () => {
  const g = N.geometry(base);
  assert.equal(N.clipPath(g), N.clipPath(g, 0));
  assert.match(N.clipPath(g), /^path\("M -48 -48 H /);
  assert.equal(N.surfaceClipPath(null), '');
});

// Chromium sizes a glass tile's clip mask to the whole path: a bottom 10000px
// down cost 36 MB per tile under the island. The clip ends one spill under the tile.
test('the clip ends just under the tile when its height is known', () => {
  const last = (p) => Number(p.match(/V (-?[\d.]+) H -?[\d.]+ Z"\)$/)[1]);
  const g = N.geometry({ ...base, height: 652 });
  assert.equal(g.height, 652);
  assert.equal(last(N.clipPath(g)), 652 + 48);
  assert.equal(last(N.surfaceClipPath(g)), 652 + 48 - base.margin);
  assert.equal(last(N.clipPath(N.collapsed(g))), 652 + 48); // the closing shape keeps it
  assert.equal(last(N.clipPath(N.geometry(base))), 10000);  // unknown height: the old reach
});

test('the line along the cutout carries on the tile border, and a tile without one gets none', () => {
  assert.deepEqual(N.edgeLine({ borderLeftWidth: '1px', borderLeftColor: 'rgb(60, 60, 60)' }), { width: 1, color: 'rgb(60, 60, 60)' });
  assert.deepEqual(N.edgeLine({ borderLeftWidth: '0.667px', borderLeftColor: 'rgb(60, 60, 60)' }), { width: 1, color: 'rgb(60, 60, 60)' });
  // The Deck's bare frame: border 0, and its computed colour is the white of the text.
  assert.deepEqual(N.edgeLine({ borderLeftWidth: '0px', borderLeftColor: 'rgb(255, 255, 255)' }), { width: 0, color: 'transparent' });
});

// A tab strip beside the cutout. The strip in base's tile: 16px in from the item's
// left, at most to 584, and the content under it starting 53px down.
const strip = { left: 16, right: 584, need: 120, under: 53 };

test('a strip that fits beside the cutout stays where it is, one ring from the wall', () => {
  // The island takes the tile's right corner: the room is on the left.
  const g = N.geometry({ ...base, pill: { left: 400, right: 700, bottom: 46, height: 44 } });
  assert.equal(g.openRight, true);
  const b = N.besideBar(g, strip);
  assert.equal(b.shift, 0);
  assert.equal(b.max, g.left - N.GAP - strip.left);
  // Exactly the room fits; a pixel more does not, and the content then starts under the cutout.
  assert.ok(N.besideBar(g, { ...strip, need: g.left - N.GAP - strip.left }));
  assert.equal(N.besideBar(g, { ...strip, need: g.left - N.GAP - strip.left + 1 }), null);
});

test('a strip moves past a cutout that takes the tile corner it starts at', () => {
  const g = N.geometry({ ...base, pill: { left: -100, right: 150, bottom: 46, height: 44 } });
  assert.equal(g.openLeft, true);
  const b = N.besideBar(g, strip);
  assert.equal(b.shift, g.right + N.GAP - strip.left);
  assert.equal(b.max, strip.right - (g.right + N.GAP));
});

test('a cutout in the middle: the left side first, else the right, else none', () => {
  const g = N.geometry(base); // walls at 192 and 408: 168px of room on each side
  assert.equal(N.besideBar(g, strip).shift, 0);
  const narrowLeft = N.geometry({ ...base, pill: { left: 120, right: 300, bottom: 46, height: 44 } });
  assert.equal(N.besideBar(narrowLeft, { ...strip, need: 150 }).shift, narrowLeft.right + N.GAP - strip.left);
  assert.equal(N.besideBar(g, { ...strip, need: 200 }), null);
});

test('the content moves down only as far as the cutout reaches', () => {
  const g = N.geometry({ ...base, pill: { left: 400, right: 700, bottom: 46, height: 44 } });
  assert.equal(N.besideBar(g, strip).under, Math.ceil(g.bottom - strip.under));
  assert.equal(N.besideBar(g, { ...strip, under: g.bottom + 30 }).under, 0);
});

test('no strip beside an island that covers the whole tile top, or without a strip', () => {
  const g = N.geometry({ ...base, pill: { left: -50, right: 700, bottom: 46, height: 44 } });
  assert.equal(N.besideBar(g, strip), null);
  assert.equal(N.besideBar(N.geometry(base), null), null);
  assert.equal(N.besideBar(null, strip), null);
  assert.equal(N.besideBar(N.geometry(base), { ...strip, need: 0 }), null);
});

// The wiring the browser check (tools/island-tabs-check) exercises on the demo.
const { readFileSync } = await import('node:fs');
const TOPBAR_JS = readFileSync(new URL('../js/topbar-minimal.js', import.meta.url), 'utf8');
const TOPBAR_CSS = readFileSync(new URL('../components/TopbarMinimal/TopbarMinimal.css', import.meta.url), 'utf8');

test('strips are read only on a shown page outside editing, and their place is part of the cutout key', () => {
  assert.match(TOPBAR_JS, /const readable = !editing && !grid\.closest\('\.pager-page\.is-parked'\);/);
  assert.match(TOPBAR_JS, /if \(!readable\) return barRooms\.get\(item\) \|\| null;/);
  assert.match(TOPBAR_JS, /const inset = bar \? parseFloat\(cs\.borderLeftWidth\) \|\| 0 : geo\.inset;/);
  assert.match(TOPBAR_JS, /\+ '\|' \+ clearance \+ '\|' \+ beside;/);
});

test('a tile the island leaves gives its strip back', () => {
  const body = (name) => TOPBAR_JS.slice(TOPBAR_JS.indexOf(`function ${name}(`), TOPBAR_JS.indexOf('\n  }\n', TOPBAR_JS.indexOf(`function ${name}(`)));
  assert.match(body('dropNotch'), /setBar\(item, null\);/);
  assert.match(body('releaseNotch'), /setBar\(item, null\);/);
});

test('the strip moves and the content under it moves down, on the cutout clock', () => {
  assert.match(TOPBAR_CSS, /\.island-clear > \.grid-stack-item-content > \.tabgroup > \.tabgroup-bar \{\s*translate: var\(--island-bar-shift, none\);\s*transition: translate var\(--island-notch-ms, 360ms\)/);
  assert.match(TOPBAR_CSS, /\.island-beside > \.grid-stack-item-content > \.tabgroup > \.tabgroup-bar \{\s*max-width: var\(--island-bar-max, none\);/);
  assert.match(TOPBAR_CSS, /\.tabgroup > \.tabgroup-body \{\s*padding-top: var\(--island-under, 0px\);\s*transition: padding-top var\(--island-notch-ms, 360ms\)/);
  assert.match(TOPBAR_CSS, /@media \(prefers-reduced-motion: reduce\) \{\s*body\.topbar-minimal \{ --island-notch-ms: 0ms; \}/);
});
