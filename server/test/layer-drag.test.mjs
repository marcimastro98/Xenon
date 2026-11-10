// One drag for the map and the screen: size kept, true edges, no jump, lines to meet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LayerDrag = require('../js/layer-drag.js');
const LayersModel = require('../js/layers-model.js');

const AREA = { w: 1000, h: 500 };
const START = { x: 400, y: 200, w: 200, h: 100 };
const lines = (others = []) => LayerDrag.linesFor(AREA, others);

test('a move never changes the size, however far it goes', () => {
  for (const [dx, dy] of [[37, 11], [-9000, -9000], [9000, 9000], [0, 0]]) {
    const { box } = LayerDrag.move(START, dx, dy, AREA, lines(), 10);
    assert.equal(box.w, 200);
    assert.equal(box.h, 100);
  }
});

test('words can stop anywhere on the screen: their box shows them where they were let go', () => {
  const size = { w: 90, h: 70 };
  const word = { w: 300, h: 30 };
  for (let x = 0; x <= AREA.w - word.w; x += 23) {
    for (let y = 0; y <= AREA.h - word.h; y += 17) {
      const box = LayerDrag.holdWords({ x, y, ...word }, size, AREA);
      const share = LayersModel.shareOf({ x: box.x / AREA.w, y: box.y / AREA.h, w: box.w / AREA.w, h: box.h / AREA.h });
      assert.ok(Math.abs(share.x * (AREA.w - word.w) - x) < 1e-6, `across at ${x}`);
      assert.ok(Math.abs(share.y * (AREA.h - word.h) - y) < 1e-6, `down at ${y}`);
      assert.deepEqual([box.w, box.h], [90, 70]);
    }
  }
});

test('words in a corner have their box in the same corner', () => {
  const box = LayerDrag.holdWords({ x: 700, y: 470, w: 300, h: 30 }, { w: 90, h: 70 }, AREA);
  assert.equal(box.x + box.w, AREA.w);
  assert.equal(box.y + box.h, AREA.h);
  assert.deepEqual(LayersModel.shareOf({ x: 0, y: 0, w: 1, h: 1 }), { x: 0, y: 0 });
});

test('words grow as a whole, within the sizes their letters have', () => {
  const seen = { x: 100, y: 40, w: 200, h: 20 };
  const size = { w: 100, h: 70 };
  const range = { min: 50, max: 300 };
  const twice = LayerDrag.scaleWords(seen, size, 200, AREA, range);
  assert.deepEqual([twice.w, twice.h], [200, 140]);
  assert.ok(Math.abs(twice.x / (AREA.w - twice.w) * (AREA.w - 400) - 100) < 1e-6, 'the words stay where they start');
  assert.equal(LayerDrag.scaleWords(seen, size, 9000, AREA, range).w, 300);
  assert.equal(LayerDrag.scaleWords(seen, size, -9000, AREA, range).w, 50);
});

test('words never grow off the screen, and a box out of range does not jump', () => {
  const seen = { x: 800, y: 40, w: 100, h: 20 };
  const big = LayerDrag.scaleWords(seen, { w: 100, h: 70 }, 9000, AREA, { min: 50, max: 900 });
  assert.equal(big.x + big.w, 1000);
  const small = LayerDrag.scaleWords({ ...seen, x: 100 }, { w: 20, h: 70 }, 0, AREA, { min: 50, max: 900 });
  assert.equal(small.w, 20);
});

test('words against the far edge still grow, back from it', () => {
  const box = LayerDrag.scaleWords({ x: 700, y: 470, w: 300, h: 30 }, { w: 90, h: 70 }, 300, AREA, { min: 50, max: 900 });
  assert.equal(box.w, 180);
  assert.equal(box.x + box.w, AREA.w);
  assert.equal(box.y + box.h, AREA.h);
});

test('the corner of a box stops at the screen and at its smallest', () => {
  const min = { w: 160, h: 120 };
  const grown = LayerDrag.stretch(START, 9000, 9000, AREA, lines(), 10, min).box;
  assert.deepEqual(grown, { x: 400, y: 200, w: 600, h: 300 });
  const shrunk = LayerDrag.stretch(START, -9000, -9000, AREA, lines(), 10, min).box;
  assert.deepEqual(shrunk, { x: 400, y: 200, w: 160, h: 120 });
});

test('the corner meets the same lines a move does', () => {
  const step = LayerDrag.stretch(START, 395, 0, AREA, lines(), 10, { w: 10, h: 10 });
  assert.equal(step.box.w, 600);
  assert.equal(step.guides.x, 1000);
});

test('it follows the pointer exactly, with no grid, away from any line', () => {
  const { box, guides } = LayerDrag.move(START, 133, -77, AREA, lines(), 10);
  assert.deepEqual([box.x, box.y], [533, 123]);
  assert.deepEqual(guides, { x: null, y: null });
});

test('dragged past the top or the side it stops on the true edge', () => {
  assert.equal(LayerDrag.move(START, 0, -9000, AREA, lines(), 10).box.y, 0);
  assert.equal(LayerDrag.move(START, 9000, 0, AREA, lines(), 10).box.x, 800);
  assert.equal(LayerDrag.move(START, 0, 9000, AREA, lines(), 10).box.y, 400);
});

test('close to an edge it is pulled onto it and the line is named', () => {
  const { box, guides } = LayerDrag.move(START, 0, -195, AREA, lines(), 10);
  assert.equal(box.y, 0);
  assert.equal(guides.y, 0);
});

test('its middle meets the middle of the screen', () => {
  const { box, guides } = LayerDrag.move({ ...START, x: 100 }, 303, 0, AREA, lines(), 10);
  assert.equal(box.x, 400);
  assert.equal(guides.x, 500);
});

test('it meets the side of another widget, and the nearest line wins', () => {
  const other = { x: 720, y: 0, w: 100, h: 100 };
  const { box, guides } = LayerDrag.move(START, 118, 0, AREA, lines([other]), 10);
  assert.equal(box.x, 520);
  assert.equal(guides.x, 720);
  assert.deepEqual(LayerDrag.pull(96, 0, [100, 90], 10), { pos: 100, line: 100 });
});

test('a box as big as its screen stays at the corner', () => {
  const big = { x: 0, y: 0, w: 1000, h: 500 };
  assert.deepEqual(LayerDrag.move(big, 40, 40, AREA, lines(), 10).box, big);
});

test('on another screen it keeps its real size and stays inside', () => {
  const box = { x: 0.9, y: 0.1, w: 0.1, h: 0.2 };
  const out = LayerDrag.carry(box, { w: 3840, h: 2160 }, { w: 1920, h: 1080 }, { x: 0.99, y: 0.5 });
  assert.equal(out.w, 0.2);
  assert.equal(out.h, 0.4);
  assert.equal(Math.round(out.x * 1000) / 1000, 0.8);
  assert.equal(out.y, 0.3);
});

test('carried to a much smaller screen it is never bigger than the screen', () => {
  const out = LayerDrag.carry({ x: 0, y: 0, w: 0.5, h: 0.5 }, { w: 3840, h: 2160 }, { w: 800, h: 480 }, { x: 0.5, y: 0.5 });
  assert.deepEqual(out, { x: 0, y: 0, w: 1, h: 1 });
});

test('the bar takes the first free spot and never covers a widget', () => {
  const size = { w: 300, h: 40 };
  const spot = (boxes) => LayerDrag.freeSpot(AREA, size, boxes, 12);
  assert.equal(spot([]), 'top');
  assert.equal(spot([{ x: 400, y: 0, w: 200, h: 100 }]), 'bottom');
  assert.equal(spot([{ x: 400, y: 0, w: 200, h: 100 }, { x: 400, y: 400, w: 200, h: 100 }]), 'top-left');
  assert.equal(spot([{ x: 0, y: 0, w: 1000, h: 500 }]), 'top', 'a full screen still has a bar');
});
