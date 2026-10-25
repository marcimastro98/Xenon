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
