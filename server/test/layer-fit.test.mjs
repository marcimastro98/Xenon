// A Store widget with `fit` sizes its own box (js/layer-fit.js): the size it asks for,
// held to the corner the box leans on, inside the screen, saved through layerMove.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const LayerFit = require('../js/layer-fit.js');
const src = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const WIN = { width: 2000, height: 1000 };

test('a box in the top right grows to the left and down from its corner', () => {
  const r = LayerFit.rectFor({ x: 0.7, y: 0.05, w: 0.25, h: 0.2 }, { w: 250, h: 30 }, WIN, { h: 'right', v: 'top' });
  assert.deepEqual(r, { x: 0.825, y: 0.05, w: 0.125, h: 0.03 });
});

test('a box in the bottom left keeps its bottom left corner', () => {
  const r = LayerFit.rectFor({ x: 0.02, y: 0.7, w: 0.2, h: 0.2 }, { w: 400, h: 100 }, WIN, { h: 'left', v: 'bottom' });
  assert.deepEqual(r, { x: 0.02, y: 0.8, w: 0.2, h: 0.1 });
});

test('a centred box stays centred, and nothing leaves the screen or gets bigger than it', () => {
  assert.deepEqual(LayerFit.rectFor({ x: 0.4, y: 0, w: 0.2, h: 0.1 }, { w: 200, h: 50 }, WIN, { h: 'middle', v: 'top' }), { x: 0.45, y: 0, w: 0.1, h: 0.05 });
  assert.deepEqual(LayerFit.rectFor({ x: 0.9, y: 0.9, w: 0.1, h: 0.1 }, { w: 5000, h: 3 }, WIN, { h: 'left', v: 'top' }), { x: 0, y: 0.9, w: 1, h: 0.016 });
});

test('only two positive px numbers are a size', () => {
  assert.deepEqual(LayerFit.cleanWant({ w: '247', h: 26 }), { w: 247, h: 26 });
  for (const bad of [null, 'x', { w: 10 }, { w: -1, h: 5 }, { w: Infinity, h: 5 }, { w: 'a', h: 'b' }]) assert.equal(LayerFit.cleanWant(bad), null);
});

test('a box within a pixel and a half of the size is left alone', () => {
  assert.ok(LayerFit.sameSize({ w: 0.1235, h: 0.026 }, { w: 247, h: 26 }, WIN));
  assert.ok(!LayerFit.sameSize({ w: 0.25, h: 0.2 }, { w: 247, h: 26 }, WIN));
});

test('the frame passes `fit` only for a package that declares it, and the pages load the module', () => {
  const cw = src('js/custom-widget.js');
  assert.match(cw, /if \(msg\.fit !== undefined\) \{ onBridgeFit\(entry, msg\.fit, reply\); return; \}/);
  assert.match(cw, /pkg\.fit !== true\) \{ reply\(false, 'not_allowed'\)/);
  for (const page of ['index.html', 'layer-lite.html']) assert.match(src(page), /<script src="js\/layer-fit\.js"><\/script>/, page);
  const fit = src('js/layer-fit.js');
  assert.match(fit, /type: 'layerMove', target: slot\.dataset\.layerId, rect:/, 'saved by the same capability as every move');
  assert.match(fit, /slot\.querySelector\('\.layer-tabs'\)\) return 'unavailable'/, 'a tab group keeps its size');
  assert.match(fit, /host\.editing\(\)\) return 'busy'/);
});
