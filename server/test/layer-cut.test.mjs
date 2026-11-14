import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { MAX_RECTS, MAX_STEPS, clipsDrawing, roundedCut, stepsFor, insetAt } = require('../js/layer-cut.js');

const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const box = { left: 100, top: 50, width: 300, height: 120 };

// True when the point lies inside the box with rounded corners of radius r.
function insideRounded(b, r, x, y) {
  const cx = Math.min(Math.max(x, b.left + r), b.left + b.width - r);
  const cy = Math.min(Math.max(y, b.top + r), b.top + b.height - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r + 1e-9;
}

test('only the Windows shell cuts its drawing to rects', () => {
  assert.equal(clipsDrawing(true, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/131'), true);
  assert.equal(clipsDrawing(true, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'), false);
  assert.equal(clipsDrawing(true, 'Mozilla/5.0 (X11; Linux x86_64)'), false);
  assert.equal(clipsDrawing(false, 'Mozilla/5.0 (Windows NT 10.0)'), false);
});

test('a square box, or no steps to spend, stays one rect', () => {
  assert.deepEqual(roundedCut(box, 0, 4), [box]);
  assert.deepEqual(roundedCut(box, 1, 4), [box]);
  assert.deepEqual(roundedCut(box, 16, 0), [box]);
});

test('a rounded box is cut in steps that never reach outside its corners', () => {
  const r = 16;
  const rects = roundedCut(box, r, 4);
  assert.equal(rects.length, 2 * 4 + 1);
  for (const b of rects) {
    for (const [x, y] of [[b.left, b.top], [b.left + b.width, b.top], [b.left, b.top + b.height], [b.left + b.width, b.top + b.height]]) {
      assert.ok(insideRounded(box, r, x, y), `corner ${x},${y} is outside the curve`);
    }
  }
});

test('the steps cover the box from top to bottom with no gap', () => {
  const rects = roundedCut(box, 16, 6).sort((a, b) => a.top - b.top);
  assert.equal(rects[0].top, box.top);
  for (let i = 1; i < rects.length; i++) assert.equal(rects[i].top, rects[i - 1].top + rects[i - 1].height);
  const last = rects[rects.length - 1];
  assert.equal(last.top + last.height, box.top + box.height);
  assert.ok(rects.every((b) => Number.isInteger(b.top - box.top) && Number.isInteger(b.height)));
});

test('the radius never exceeds half the box', () => {
  const thin = { left: 0, top: 0, width: 200, height: 20 };
  const rects = roundedCut(thin, 50, 4);
  assert.ok(rects.every((b) => b.top >= 0 && b.top + b.height <= 20 && b.width > 0));
  assert.equal(insetAt(10, 10), 0);
  assert.equal(insetAt(10, 0), 10);
});

test('the steps fit the shell budget, and fall back to square boxes when they cannot', () => {
  const one = [{ box, radius: 16 }];
  assert.equal(stepsFor(one, MAX_RECTS), MAX_STEPS);
  const eight = Array.from({ length: 8 }, () => ({ box, radius: 16 }));
  const n = stepsFor(eight, MAX_RECTS);
  assert.ok(8 * (2 * n + 1) <= MAX_RECTS);
  assert.equal(stepsFor(Array.from({ length: 20 }, () => ({ box, radius: 16 })), MAX_RECTS), 0);
  assert.equal(stepsFor([{ box, radius: 0 }], MAX_RECTS), 0);
  const mixed = [{ box, radius: 16 }, ...Array.from({ length: 5 }, () => ({ box, radius: 0 }))];
  assert.ok(5 + 2 * stepsFor(mixed, MAX_RECTS) + 1 <= MAX_RECTS);
});

test('the budget matches what the shell reads', () => {
  assert.match(src('../../apps/native/src-tauri/src/layers/spec.rs'), new RegExp(`MAX_RECTS: usize = ${MAX_RECTS};`));
});

test('the layer page loads the cut before the host and the host uses it', () => {
  for (const page of ['../index.html', '../layer-lite.html']) {
    const html = src(page);
    assert.ok(html.indexOf('js/layer-cut.js') > 0 && html.indexOf('js/layer-cut.js') < html.indexOf('js/layer-host.js'), page);
  }
  const host = src('../js/layer-host.js');
  assert.match(host, /LayerCut\.clipsDrawing\(SHELL, navigator\.userAgent\)/);
  assert.match(host, /CUT\.roundedCut\(it\.box, it\.radius, steps\)/);
});

test('a Store widget that sizes its own box keeps the size it asked for', () => {
  const css = src('../components/LayerHost/LayerHost.css');
  assert.match(css, /\.layer-slot\[data-small\]\[data-fit\]:not\(:has\(\.cw-state\)\) \{\s*--layer-min-w: 16px;\s*--layer-min-h: 16px;/);
  assert.match(src('../js/layer-fit.js'), /slot\.dataset\.fit = 'true';\s*const box = boxOf\(slot\);/);
});
