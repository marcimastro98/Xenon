// packages/core/src/bit-cells-warp.js: Bit going and coming on the desktop, made of its own cells,
// so the shell plays it like any clip: crumble out, assemble in, a beam in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const W = require('../src/bit-cells-warp.js');
const C = require('../src/bit-cells.js');
const bit = require('../src/bit.js');
require('../src/bit-clips-life.js');
const genome = require('../src/bit-genome.js');
const bitLook = require('../src/bit-look.js');

const LOOK = bitLook.lookOf(genome.decode('0123456789abcdef'), { background: '#0d1117' });
const idle = C.cells(bit.renderFrame(bit.clip('idle'), 0, { look: LOOK }).layers);
const BOX = { x0: -4, x1: 15, y0: -8, y1: 12, max: 24 }; // desk.js
const same = (a, b) => assert.deepEqual([...a].sort(), [...b].sort());
const colours = (maps) => new Set(maps.flatMap((m) => [...m.values()]));

test('crumble: whole Bit first, nothing left by the last frame, only its own colours', () => {
  const f = W.crumble(idle);
  assert.equal(f.length, W.KINDS.crumble.n);
  same(f[0], idle);
  assert.equal(f.at(-1).size, 0);
  assert.ok(f[4].size > 0 && f[4].size < idle.size, 'some bits already gone halfway');
  assert.deepEqual([...colours(f)].filter((c) => ![...idle.values()].includes(c)), []);
  assert.deepEqual(W.crumble(idle), f, 'the same seed gives the same frames');
  assert.notDeepEqual(W.crumble(idle, 10, 7), f);
});

test('assemble comes back from nothing to the whole Bit; beam drops a line, then opens into it', () => {
  const a = W.assemble(idle);
  assert.equal(a[0].size, 0);
  same(a.at(-1), idle);
  const b = W.beam(idle);
  assert.equal(b.length, W.KINDS.beam.n);
  const xs = (m) => new Set([...m.keys()].map((k) => k.split(',')[0]));
  assert.equal(xs(b[0]).size, 1, 'one column of light');
  assert.ok(b[1].size >= b[0].size, 'the line grows down');
  same(b.at(-1), idle);
});

test('every frame fits the desktop grid with the idle loop, under 16 colours', () => {
  for (const kind of Object.keys(W.KINDS)) {
    const { maps, ms } = W.frames(kind, idle);
    assert.ok(ms >= 40 && maps.length <= 24, kind);
    const g = C.grid([idle, ...maps], BOX);
    assert.ok(g && g.palette.length <= 16, kind);
  }
  assert.equal(W.frames('nope', idle), null);
  assert.deepEqual(W.crumble(new Map(), 3).map((m) => m.size), [0, 0, 0], 'an empty Bit stays empty');
});
