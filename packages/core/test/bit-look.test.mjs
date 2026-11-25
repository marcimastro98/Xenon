import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const data = require('../src/bit-clips.js');
const bit = require('../src/bit.js');
const G = require('../src/bit-genes.js');
const genome = require('../src/bit-genome.js');
const looks = require('../src/bit-look.js');
const wardrobe = require('../src/bit-wardrobe.js');

const SEED = '0123456789abcdef';
const lookFor = (seed, opts) => looks.lookOf(genome.decode(seed), opts);
const bodyLayer = (frame) => frame.layers.find((l) => l.clipFloor && l.rects.length > data.BODY.length);
const key = (r) => `${r.x},${r.y},${r.w},${r.h}`;

test('a personal Bit keeps the brand body, in its own colour', () => {
  const look = lookFor(SEED);
  for (const c of bit.clips) {
    const rects = bodyLayer(bit.renderFrame(c, 0, { look })).rects.slice(0, data.BODY.length);
    assert.ok(rects.every((r) => r.fill === look.body), c.id);
    const plain = bodyLayer(bit.renderFrame(c, 0)).rects.slice(0, data.BODY.length);
    assert.deepEqual(rects.map(key), plain.map(key), c.id);
  }
});

test('the mood lights the antenna tip, not the body', () => {
  const look = lookFor(SEED);
  const hot = bodyLayer(bit.renderFrame('idle', 0, { look, tint: '255,90,110' })).rects;
  const tip = new Set(look.tip.light.map(([x, y]) => `${x},${y}`));
  const lit = hot.filter((r) => tip.has(`${r.x},${r.y}`) && r.fill === 'rgb(255,90,110)');
  assert.equal(lit.length, tip.size);
});

test('pale Bits get an outline on light screens only', () => {
  const pale = { ...genome.decode(SEED), palette: 'lemon-pastel', classic: false };
  assert.ok(looks.lookOf(pale, { background: '#f4f6f5' }).outline);
  assert.equal(looks.lookOf(pale, { background: '#0b0f14' }).outline, null);
  assert.equal(looks.lookOf(pale).outline, null);
});

test('markings stay on the body, and off the face unless cream', () => {
  for (const p of G.PATTERNS) {
    for (const cell of looks.unitCells(p.cells)) {
      assert.ok(looks.inBody(cell), `${p.id} ${cell}`);
      if (p.role === 'mark') assert.ok(!looks.inFace(cell), `${p.id} ${cell}`);
    }
  }
});

test('the egg hides the whole Bit, tip included, until it hatches', () => {
  const egg = new Set(['eggTop', 'eggBottom'].flatMap((n) => looks.unitCells(bit.parts[n].cells)).map(String));
  const tips = G.TIPS.flatMap((t) => looks.unitCells([...t.stem, ...t.light]));
  for (const cell of [...looks.unitCells(data.BODY), ...tips]) assert.ok(egg.has(String(cell)), `${cell} shows`);
  const hatch = bit.clip('hatch');
  assert.equal(hatch.kind, 'react');
  const first = bit.renderFrame(hatch, 0, { look: lookFor(SEED) });
  assert.equal(first.layers.at(-1).transform, null, 'the egg is drawn in front');
  assert.ok(!hatch.frames.at(-1).ex, 'Bit ends out of the shell');
});

test('worn items take the Bit\'s colours and keep the eyes on top', () => {
  const g = genome.decode(SEED);
  const pal = genome.palette(g.palette);
  const look = looks.lookOf(g, { worn: wardrobe.outfit(['beanie', 'glasses']) });
  const rects = bodyLayer(bit.renderFrame('idle', 0, { look })).rects;
  assert.ok(rects.some((r) => r.fill === pal.accent), 'beanie in the accent colour');
  const rim = rects.findIndex((r) => r.fill === pal.line);
  const eye = rects.findLastIndex((r) => r.x === 4 && r.y === 4);
  assert.ok(rim >= 0 && eye > rim, 'eyes drawn after the glasses');
});

test('an item that would leave the stage is set down for that clip only', () => {
  const look = lookFor(SEED, { worn: wardrobe.outfit(['mug']) });
  const has = (clipId) => bit.renderFrame(clipId, 0, { look }).layers.some((l) => l.rects.some((r) => r.fill === '#f0f3f1'));
  assert.ok(has('idle'));
  assert.ok(!has('moonwalk'));
});

test('an outfit holds one item per slot and drops unknown ids', () => {
  const o = wardrobe.outfit(['cap', 'beanie', 'nope', 'scarf']);
  assert.deepEqual(o.map((i) => i.id), ['beanie', 'scarf']);
  assert.deepEqual(wardrobe.outfit(null), []);
  for (const it of wardrobe.ITEMS) assert.deepEqual(wardrobe.validate(it), [], it.id);
  assert.ok(wardrobe.validate({ id: 'x', slot: 'hat', source: 'shop', layers: [{ fill: 'red', cells: [[6, 0]] }] }).length >= 4);
});
