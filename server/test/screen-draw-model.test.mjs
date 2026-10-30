// js/screen-draw-model.js: the strokes and keys of the macOS/Linux drawing
// sheet (draw.html). Pinned here: the same tools, modifiers, keys and limits as
// the capture engine's sheet on Windows, so the feature is one feature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../js/screen-draw-model.js');

test('six colours with their keys and four tools, as on Windows', () => {
  assert.equal(M.PALETTE.map((p) => p.key).join(''), 'RYGBWK');
  assert.deepEqual(M.PALETTE[0].rgb, [232, 64, 64]);
  assert.deepEqual(M.TOOLS, ['pen', 'marker', 'arrow', 'box']);
  assert.equal(M.ALPHA.marker, 0.4);
  assert.equal(M.width({ tool: 'pen' }, 2), 10);
  assert.equal(M.width({ tool: 'marker' }, 1), 22);
});

test('a pen stroke keeps every point; Shift draws it straight; Ctrl a box, Ctrl+Shift an arrow', () => {
  const s = M.create();
  s.begin([0, 0]); s.extend([5, 5]); s.extend([9, 2]);
  assert.equal(s.end(), true);
  assert.equal(s.strokes[0].points.length, 3);
  s.begin([0, 0], { shift: true }); s.extend([5, 5]); s.extend([10, 0]);
  s.end();
  assert.equal(s.strokes[1].straight, true);
  assert.deepEqual(M.paths(s.strokes[1]), [[[0, 0], [10, 0]]]);
  assert.equal(s.begin([0, 0], { ctrl: true }).tool, 'box');
  s.extend([10, 20]); s.end();
  assert.deepEqual(M.paths(s.strokes[2])[0], [[0, 0], [10, 0], [10, 20], [0, 20], [0, 0]]);
  assert.equal(s.begin([0, 0], { ctrl: true, shift: true }).tool, 'arrow');
  s.extend([100, 0]); s.end();
  assert.equal(M.paths(s.strokes[3]).length, 3, 'the shaft and the two lines of the head');
  // A Shift line is for the pen and the highlighter only.
  s.pick({ tool: 'box' });
  assert.equal(s.begin([0, 0], { shift: true }).straight, false);
});

test('a box or arrow that never moved draws nothing; a dot does', () => {
  const s = M.create();
  s.begin([3, 3], { ctrl: true }); s.extend([3.4, 3.2]);
  assert.equal(s.end(), false);
  s.begin([3, 3]);
  assert.equal(s.end(), true);
  assert.equal(s.strokes.length, 1);
  assert.equal(s.end(), false, 'no press, no stroke');
});

test('the arrow head follows the engine: 6x the radius, at least 14, at most 60% of the shaft', () => {
  const [h1, h2] = M.arrowHead([0, 0], [100, 0], 3);
  assert.ok(Math.abs(Math.hypot(100 - h1[0], h1[1]) - 18) < 1e-9);
  assert.ok((h1[1] < 0) !== (h2[1] < 0), 'one line on each side');
  const [s1] = M.arrowHead([0, 0], [10, 0], 3);
  assert.ok(Math.abs(Math.hypot(10 - s1[0], s1[1]) - 6) < 1e-9);
  assert.deepEqual(M.arrowHead([0, 0], [0.2, 0], 3), []);
});

test('undo drops the stroke in progress first, then the last one; clear says whether there was anything', () => {
  const s = M.create();
  s.begin([0, 0]); s.end();
  s.begin([1, 1]);
  assert.equal(s.undo(), true);
  assert.equal(s.live, null);
  assert.equal(s.strokes.length, 1);
  assert.equal(s.undo(), true);
  assert.equal(s.undo(), false);
  assert.equal(s.clear(), false);
  s.begin([0, 0]); s.end();
  assert.equal(s.clear(), true);
  assert.equal(s.strokes.length, 0);
});

test('a stroke takes the colour picked when it starts; bad picks are ignored', () => {
  const s = M.create();
  s.pick({ colour: 3 });
  s.pick({ colour: 9 });
  s.pick({ colour: -1 });
  s.pick({ tool: 'spray' });
  assert.equal(s.colour, 3);
  assert.equal(s.tool, 'pen');
  s.begin([0, 0]);
  s.pick({ colour: 0 });
  assert.deepEqual(s.live.rgb, M.PALETTE[3].rgb);
});

test('long strokes are thinned, never cut, and the sheet keeps at most 500', () => {
  const s = M.create();
  s.begin([0, 0]);
  for (let i = 1; i <= 5000; i++) s.extend([i, 0]);
  assert.equal(s.live.points.length, 4000);
  assert.deepEqual(s.live.points.at(-1), [5000, 0]);
  s.end();
  for (let i = 0; i < 600; i++) { s.begin([i, i]); s.end(); }
  assert.equal(s.strokes.length, 500);
  assert.deepEqual(s.strokes.at(-1).points[0], [599, 599]);
});

test('keys: Esc closes, Ctrl+Z undoes, E or Delete clears, a colour letter picks it, the rest is left alone', () => {
  assert.deepEqual(M.keyAction('Escape'), { act: 'close' });
  assert.deepEqual(M.keyAction('z', { ctrl: true }), { act: 'undo' });
  assert.deepEqual(M.keyAction('Z', { ctrl: true }), { act: 'undo' });
  assert.deepEqual(M.keyAction('e'), { act: 'clear' });
  assert.deepEqual(M.keyAction('Delete'), { act: 'clear' });
  assert.deepEqual(M.keyAction('g'), { colour: 2 });
  assert.deepEqual(M.keyAction('K'), { colour: 5 });
  assert.equal(M.keyAction('r', { ctrl: true }), null);
  assert.equal(M.keyAction('e', { alt: true }), null);
  assert.equal(M.keyAction('q'), null);
  assert.equal(M.keyAction('Backspace'), null);
  assert.equal(M.keyAction(undefined), null);
});
