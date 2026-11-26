// packages/core/src/bit-cells.js: a rendered Bit frame as the solid cells it fills, and frames as
// one grid of letters on up to 16 colours (the Windows popup, Bit on the desktop).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../src/bit-cells.js');
const bit = require('../src/bit.js');

const layer = (rects, transform = null, clipFloor = false) => ({ transform, clipFloor, rects });
const rect = (x, y, w, h, fill = '#aabbcc', o) => ({ x, y, w, h, fill, o });

test('colours come as six hex digits, anything else is no colour', () => {
  assert.equal(C.hex('#AABBCC'), 'aabbcc');
  assert.equal(C.hex('rgb(255, 0, 16)'), 'ff0010');
  assert.equal(C.hex('url(#x)'), '');
  assert.equal(C.hex('#abc'), '');
});

test('cells: painted in order, soft marks left out, the transform and the floor applied', () => {
  const plain = C.cells([layer([rect(0, 0, 2, 1), rect(1, 0, 1, 1, '#112233'), rect(5, 5, 1, 1, '#000000', 0.3)])]);
  assert.deepEqual([...plain], [['0,0', 'aabbcc'], ['1,0', '112233']], 'a later rect covers, a soft one is off');
  const moved = C.cells([layer([rect(0, 0, 1, 1)], { dx: 2, dy: -1, sx: 1, sy: 1, px: 6, py: 11 })]);
  assert.deepEqual([...moved.keys()], ['2,-1']);
  // Mirrored around px 6: x 4..5 lands on 7..8.
  const flipped = C.cells([layer([rect(4, 0, 1, 1)], { dx: 0, dy: 0, sx: -1, sy: 1, px: 6, py: 11 })]);
  assert.deepEqual([...flipped.keys()], ['7,0']);
  const clipped = C.cells([layer([rect(0, 9, 1, 4)], null, true)]);
  assert.deepEqual([...clipped.keys()], ['0,9', '0,10'], 'nothing under the floor');
});

test('grid: one box for every frame, letters on one palette, cut to the sides given', () => {
  const a = new Map([['0,0', 'ff0000'], ['1,1', '00ff00']]);
  const b = new Map([['2,1', 'ff0000']]);
  const g = C.grid([a, b]);
  assert.deepEqual(g.palette, ['ff0000', '00ff00']);
  assert.deepEqual(g.frames, [['A..', '.B.'], ['...', '..A']]);
  const box = C.grid([a, b], { x0: -1, x1: 1, y0: -1, y1: 1 });
  assert.deepEqual(box.frames[0], ['...', '.A.', '..B'], 'a fixed box, empty where nothing is');
  assert.deepEqual(box.frames[1], ['...', '...', '...'], 'and cut where it ends');
  assert.equal(C.grid([new Map([['0,0', 'ff0000'], ['30,0', 'ff0000']])]), null, 'too wide');
  const many = new Map(Array.from({ length: 17 }, (_, i) => [`${i},0`, i.toString(16).padStart(6, '0')]));
  assert.equal(C.grid([many], { max: 24 }), null, 'more than 16 colours');
  assert.equal(C.grid([new Map()]), null);
});

test('every clip of the engine fits the desktop box', () => {
  const BOX = { x0: -4, x1: 15, y0: -8, y1: 12, max: 24 };
  for (const clip of Object.values(bit.clips)) {
    if (!clip?.frames || clip.frames.length > 24) continue;
    const g = C.grid(clip.frames.map((_, i) => C.cells(bit.renderFrame(clip, i).layers)), BOX);
    assert.ok(g, `${clip.id} fits`);
    assert.equal(g.frames[0].length, 21);
    assert.ok(g.frames.every((f) => f.every((row) => row.length === 20)), `${clip.id} rows`);
  }
});
