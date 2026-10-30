// The Scintilla (src/bit-spark.js): Bit's spark, drawn the way Bit is drawn.
// What these hold: the star is the same shape every way it is turned, Bit's
// ink closes it on every side (so it reads on a light theme), it has eyes,
// the twinkle is three frames, and an empty balance is grey, still and asleep.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const spark = require('../src/bit-spark.js');

// The cells of one frame group: "x,y" -> fill.
function frames(markup) {
  return [...markup.matchAll(/<g class="xspark-f(\d)">(.*?)<\/g>/g)].map((m) => {
    const cells = new Map();
    for (const r of m[2].matchAll(/<rect x="(\d+)" y="(\d+)" width="1" height="1" fill="(#[0-9a-f]{6})"\/>/g)) cells.set(`${r[1]},${r[2]}`, r[3]);
    return cells;
  });
}

test('the spark is three crisp frames on a 15 cell grid, sized by CSS unless asked', () => {
  const svg = spark.svg();
  assert.match(svg, /^<svg class="xspark" viewBox="0 0 15 15" shape-rendering="crispEdges" aria-hidden="true" focusable="false">/);
  assert.equal(frames(svg).length, 3);
  assert.match(spark.svg({ size: 16 }), / width="16" height="16"/);
  for (const f of frames(svg)) for (const k of f.keys()) {
    const [x, y] = k.split(',').map(Number);
    assert.ok(x >= 0 && y >= 0 && x < spark.SIZE && y < spark.SIZE, `${k} inside the grid`);
  }
});

test('the star is the same turned or mirrored, and Bit ink closes it on every side', () => {
  const [rest] = frames(spark.svg({ still: true }));
  const lit = Object.values(spark.COLORS.lit);
  const body = new Set([...rest].filter(([k, fill]) => lit.includes(fill)).map(([k]) => k));
  const eyes = [...rest].filter(([k, fill]) => fill === spark.INK).map(([k]) => k).filter((k) => {
    const [x, y] = k.split(',').map(Number);
    return [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].every(([a, b]) => body.has(`${a},${b}`) || rest.get(`${a},${b}`) === spark.INK);
  });
  const star = new Set([...body, ...eyes]);
  for (const k of star) {
    const [x, y] = k.split(',').map(Number);
    assert.ok(star.has(`${y},${x}`), `turned: ${k}`);
    assert.ok(star.has(`${14 - x},${y}`), `mirrored: ${k}`);
    for (const [a, b] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      assert.ok(star.has(`${a},${b}`) || rest.get(`${a},${b}`) === spark.INK, `ink beside ${k}`);
    }
  }
  assert.equal(eyes.length, 4, 'two eyes, two cells each');
  assert.equal(rest.get('7,7'), spark.COLORS.lit.core, 'a warm white heart');
});

test('it twinkles with glints, then blinks', () => {
  const [rest, twinkle, blink] = frames(spark.svg());
  const ink = (f) => [...f.values()].filter((v) => v === spark.INK).length;
  assert.ok(twinkle.size > rest.size, 'the twinkle adds glints');
  for (const k of ['2,2', '12,2', '2,12', '12,12']) assert.equal(twinkle.get(k), spark.COLORS.lit.glint, k);
  assert.equal(ink(blink), ink(rest) - 2, 'a blink closes the eyes to one row');
});

test('an empty balance draws it grey, still and asleep', () => {
  const svg = spark.svg({ dim: true });
  assert.match(svg, /class="xspark xspark-still"/);
  const all = frames(svg);
  assert.equal(all.length, 1);
  const lit = Object.values(spark.COLORS.lit);
  assert.ok([...all[0].values()].every((v) => !lit.includes(v)), 'no warm colour left');
  const [awake] = frames(spark.svg({ still: true }));
  const ink = (f) => [...f.values()].filter((v) => v === spark.INK).length;
  assert.equal(ink(all[0]), ink(awake) - 2, 'eyes shut');
});
