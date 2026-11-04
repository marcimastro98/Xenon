// tools/site-shots/desktop.mjs: the home page's desktop picture is placed tiles
// on the demo's layer page, inside the screen, apart from each other and from
// the wallpaper's clock on the left.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PLAN, desktopLayers, seedScript } from '../../tools/site-shots/desktop.mjs';

const require = createRequire(import.meta.url);
const LayerTiles = require('../js/layer-tiles.js');

test('every planned tile is a light tile, inside the screen and right of the clock', () => {
  for (const [tile, r] of PLAN) {
    assert.ok(LayerTiles.LITE.includes(tile), `${tile} is not a light layer tile`);
    assert.ok(r.x >= 0.4 && r.y >= 0 && r.x + r.w <= 1 && r.y + r.h <= 1, `${tile} out of bounds`);
  }
});

test('the planned tiles do not overlap', () => {
  const rects = PLAN.map(([, r]) => r);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]; const b = rects[j];
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `${PLAN[i][0]} overlaps ${PLAN[j][0]}`);
    }
  }
});

test('the seed places the tiles on one desktop surface and keeps the wallpaper to its clock', () => {
  const layers = desktopLayers();
  assert.equal(layers.widgets.length, PLAN.length);
  assert.ok(layers.widgets.every((w) => w.kind === 'tile' && w.surface === 'desktop' && w.monitor === 'site'));
  assert.equal(new Set(layers.widgets.map((w) => w.id)).size, PLAN.length);
  assert.match(seedScript(), /lockWidgets = \{ clock: true, weather: false, media: false, calendar: false \}/);
});
