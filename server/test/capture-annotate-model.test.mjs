// js/capture-annotate-model.js: the screenshot editor's shapes and painting.
// Pinned here: a drag makes a shape inside the picture (any corner order), a
// tap makes none; a cover is always black and carries no colour; the engine's
// spots become covers once; a tap finds the topmost mark; undo takes back one
// gesture (a whole "find" at once); the same paint draws preview and file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const A = require('../js/capture-annotate-model.js');

const SIZE = { width: 1920, height: 1080 };
const RED = A.COLORS[0];

function fakeCtx() {
  const calls = [];
  const ctx = new Proxy({ calls }, {
    get(t, k) {
      if (k === 'calls') return calls;
      if (k === 'measureText') return (s) => ({ width: s.length * 10 });
      if (k in t) return t[k];
      return (...args) => calls.push([k, ...args]);
    },
    set(t, k, v) { calls.push(['set', k, v]); t[k] = v; return true; },
  });
  return ctx;
}

test('a drag makes a shape in any corner order, kept inside the picture', () => {
  assert.deepEqual(A.shapeFrom('box', { x: 500, y: 400 }, { x: 100, y: 50 }, RED, SIZE), { tool: 'box', color: RED, x: 100, y: 50, w: 400, h: 350 });
  assert.deepEqual(A.shapeFrom('highlight', { x: -50, y: 1000 }, { x: 60, y: 1200 }, RED, SIZE), { tool: 'highlight', color: RED, x: 0, y: 1000, w: 60, h: 80 });
  assert.deepEqual(A.shapeFrom('arrow', { x: 10, y: 10 }, { x: 3000, y: 20 }, RED, SIZE), { tool: 'arrow', color: RED, x1: 10, y1: 10, x2: 1920, y2: 20 });
  assert.deepEqual(A.shapeFrom('cover', { x: 1, y: 1 }, { x: 11, y: 21 }, RED, SIZE), { tool: 'cover', x: 1, y: 1, w: 10, h: 20 }, 'no colour on a cover');
});

test('too small to mean anything, or a tool that is not a drag: no shape', () => {
  assert.equal(A.shapeFrom('box', { x: 10, y: 10 }, { x: 12, y: 40 }, RED, SIZE, 5), null);
  assert.equal(A.shapeFrom('arrow', { x: 10, y: 10 }, { x: 12, y: 11 }, RED, SIZE, 5), null);
  assert.equal(A.shapeFrom('text', { x: 10, y: 10 }, { x: 100, y: 100 }, RED, SIZE), null);
  assert.equal(A.shapeFrom('pen', { x: 10, y: 10 }, { x: 100, y: 100 }, RED, SIZE), null);
});

test('a label: one line, trimmed, capped, inside the picture', () => {
  assert.deepEqual(A.textShape({ x: 5000, y: -3 }, '  hello\n  world ', RED, SIZE), { tool: 'text', color: RED, text: 'hello world', x: 1920, y: 0 });
  assert.equal(A.textShape({ x: 1, y: 1 }, '   ', RED, SIZE), null);
  assert.equal(A.textShape({ x: 1, y: 1 }, 'x'.repeat(500), RED, SIZE).text.length, A.MAX_TEXT);
});

test('the engine\'s spots become covers once', () => {
  const spots = [{ kind: 'email', x: 1, y: 2, w: 30, h: 10 }, { kind: 'number', x: 50, y: 2, w: 30, h: 10 }, { kind: 'email', x: 1, y: 2, w: 30, h: 10 }];
  const first = A.coversFrom(spots, []);
  assert.deepEqual(first, [{ tool: 'cover', x: 1, y: 2, w: 30, h: 10 }, { tool: 'cover', x: 50, y: 2, w: 30, h: 10 }]);
  assert.deepEqual(A.coversFrom(spots, first), [], 'a second find adds nothing');
  assert.deepEqual(A.coversFrom(null, []), []);
});

test('a tap finds the topmost mark under it', () => {
  const shapes = [
    { tool: 'box', color: RED, x: 0, y: 0, w: 500, h: 500 },
    { tool: 'cover', x: 100, y: 100, w: 50, h: 20 },
    { tool: 'arrow', color: RED, x1: 900, y1: 900, x2: 800, y2: 950 },
    { tool: 'text', color: RED, text: 'hi', x: 1500, y: 100 },
  ];
  assert.equal(A.hitTest(shapes, { x: 120, y: 110 }, SIZE, 2), 1);
  assert.equal(A.hitTest(shapes, { x: 10, y: 10 }, SIZE, 2), 0);
  assert.equal(A.hitTest(shapes, { x: 850, y: 920 }, SIZE, 2), 2);
  assert.equal(A.hitTest(shapes, { x: 1505, y: 110 }, SIZE, 2, () => 40), 3);
  assert.equal(A.hitTest(shapes, { x: 1800, y: 1000 }, SIZE, 2), -1);
});

test('undo takes back one gesture; a find is one step; a removal is one step', () => {
  const h = A.createHistory();
  assert.equal(h.canUndo, false);
  h.add([{ tool: 'box', color: RED, x: 0, y: 0, w: 10, h: 10 }]);
  h.add([{ tool: 'cover', x: 1, y: 1, w: 5, h: 5 }, { tool: 'cover', x: 9, y: 9, w: 5, h: 5 }]);
  assert.equal(h.shapes.length, 3);
  h.removeAt(0);
  assert.deepEqual(h.shapes.map(s => s.tool), ['cover', 'cover']);
  h.undo();
  assert.equal(h.shapes.length, 3);
  h.undo();
  assert.equal(h.shapes.length, 1);
  h.undo();
  assert.equal(h.shapes.length, 0);
  assert.equal(h.canUndo, false);
  assert.equal(h.add([]), false);
  assert.equal(h.removeAt(5), false);
});

test('there is a ceiling on marks, so a runaway find cannot grow without end', () => {
  const h = A.createHistory();
  const many = Array.from({ length: A.MAX_SHAPES + 1 }, (_, i) => ({ tool: 'cover', x: i, y: 0, w: 1, h: 1 }));
  assert.equal(h.add(many), false);
  assert.equal(h.shapes.length, 0);
});

test('a cover paints solid black whatever colour is picked; lines grow with the picture', () => {
  const ctx = fakeCtx();
  A.paint(ctx, [{ tool: 'cover', x: 1, y: 2, w: 3, h: 4 }], SIZE);
  assert.ok(ctx.calls.some(c => c[0] === 'set' && c[1] === 'fillStyle' && c[2] === '#000000'));
  assert.ok(ctx.calls.some(c => c[0] === 'fillRect' && c[1] === 1 && c[4] === 4));
  assert.ok(!ctx.calls.some(c => c[0] === 'set' && c[1] === 'globalAlpha'), 'a cover is never see-through');
  assert.ok(A.strokeFor(3840, 2160) > A.strokeFor(1280, 720));
  assert.ok(A.fontFor(3840, 2160) > A.fontFor(1280, 720));
  assert.equal(A.strokeFor(100, 100), 3);
});

test('every tool paints; save() asks for a PNG of the picture\'s own size', () => {
  const ctx = fakeCtx();
  A.paint(ctx, [
    { tool: 'arrow', color: RED, x1: 0, y1: 0, x2: 100, y2: 100 },
    { tool: 'box', color: RED, x: 0, y: 0, w: 50, h: 50 },
    { tool: 'highlight', color: RED, x: 0, y: 0, w: 50, h: 50 },
    { tool: 'text', color: RED, text: 'hi', x: 0, y: 0 },
  ], SIZE);
  for (const k of ['stroke', 'fill', 'strokeRect', 'fillText']) assert.ok(ctx.calls.some(c => c[0] === k), k);
  const editor = readFileSync(new URL('../js/capture-annotate.js', import.meta.url), 'utf8');
  assert.match(editor, /out\.width = size\.width;\s+out\.height = size\.height;/);
  assert.match(editor, /toBlob\(resolve, 'image\/png'\)/);
  assert.match(editor, /'\/captures\/save\?id=' \+ encodeURIComponent\(o\.entry\.id\)/);
  assert.doesNotMatch(editor, /innerHTML = (?!ICONS\[)/, 'only the static icons go through innerHTML');
  assert.match(editor, /saved = !history\.shapes\.length;/, 'undoing every mark: nothing to save, Esc leaves at once');
});

test('the viewer loads the editor only when Edit is pressed, pictures only', () => {
  const viewer = readFileSync(new URL('../js/capture-gallery-viewer.js', import.meta.url), 'utf8');
  // Screenshots only: a GIF copy is a picture too, but the editor saves a PNG.
  assert.match(viewer, /if \(e\.kind === 'screenshot'\) actions\.appendChild\(btn\(tr\('capg_edit', 'Edit'\), '', edit\)\);/);
  assert.match(viewer, /'js\/capture-annotate-model\.js', 'js\/capture-annotate\.js'/);
  assert.match(viewer, /if \(editor\) return; \/\/ the editor has its own keys/);
  const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(index, /capture-annotate/, 'not in the page until used');
});
