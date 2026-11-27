// The Bit Lab's rules for personal Bits, as pure checks: each returns a list
// of problems, empty when all is well. `node tools/bit-lab/cli.mjs check` and
// packages/core/test/bit-genome.test.mjs both run them.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const clips = require('../../packages/core/src/bit-clips.js');
const bit = require('../../packages/core/src/bit.js');
const G = require('../../packages/core/src/bit-genes.js');
const genome = require('../../packages/core/src/bit-genome.js');
const looks = require('../../packages/core/src/bit-look.js');
const color = require('../../packages/core/src/bit-color.js');
const wardrobe = require('../../packages/core/src/bit-wardrobe.js');

const FACE_CONTRAST = 4.5; // WCAG AA for the eyes and mouth on the body
const PIVOT = [6, 11];
const { STAGE } = bit;

/** Body and cream (under the face) keep the ink face and every eye colour readable. */
export function checkColours() {
  const problems = [];
  const eyes = G.EYES.map((e) => [e.id, e.L == null ? clips.INK : color.oklch(e.L, e.C, e.h)]);
  for (const p of [...genome.PALETTES, genome.palette('classic')]) {
    for (const [role, bg] of [['body', p.body], ['cream', p.cream]]) {
      for (const [id, eye] of eyes) {
        const c = color.contrast(eye, bg);
        if (c < FACE_CONTRAST) problems.push(`${p.id} ${role}: eyes ${id} ${c.toFixed(2)}:1`);
      }
    }
  }
  return problems;
}

/** Markings sit on the body, off the face unless cream, and no two are the same. */
export function checkPatterns() {
  const problems = [];
  const seen = new Set();
  for (const p of G.PATTERNS) {
    const cells = looks.unitCells(p.cells);
    const key = JSON.stringify(cells.map(String).sort());
    if (seen.has(key)) problems.push(`${p.id}: same cells as another pattern`);
    seen.add(key);
    for (const c of cells) {
      if (!looks.inBody(c)) problems.push(`${p.id}: ${c} is off the body`);
      if (p.role === 'mark' && looks.inFace(c)) problems.push(`${p.id}: ${c} covers the face`);
    }
    if (p.role !== 'none' && !cells.length) problems.push(`${p.id}: no cells`);
  }
  return problems;
}

function allTipCells() {
  return G.TIPS.flatMap((t) => looks.unitCells([...t.stem, ...t.light]));
}

/** Tips sit above the head, stay in rows -1..-2 and are all different. */
export function checkTips() {
  const problems = [];
  const seen = new Set();
  for (const t of G.TIPS) {
    const cells = looks.unitCells([...t.stem, ...t.light]);
    const key = JSON.stringify([t.stem, t.light]);
    if (seen.has(key)) problems.push(`${t.id}: same as another tip`);
    seen.add(key);
    if (!t.light.length) problems.push(`${t.id}: no light, so no mood`);
    for (const [x, y] of cells) if (y < -2 || y > -1 || x < 3 || x > 9) problems.push(`${t.id}: ${x},${y} outside the tip area`);
  }
  return problems;
}

function placed([x, y], f) {
  const sx = f.sx == null ? 1 : f.sx;
  const sy = f.sy == null ? 1 : f.sy;
  const xs = [x, x + 1].map((v) => (f.dx || 0) + PIVOT[0] + sx * (v - PIVOT[0]));
  const ys = [y, y + 1].map((v) => (f.dy || 0) + PIVOT[1] + sy * (v - PIVOT[1]));
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

function leaves(cells, f) {
  return cells.some((cell) => {
    const r = placed(cell, f);
    return r.x0 < STAGE.x - 0.01 || r.x1 > STAGE.x + STAGE.w + 0.01 || r.y0 < STAGE.y - 0.01;
  });
}

// How a frame moves an item of each place: a home and a prop never move, a ride only follows the
// body's moves, the rest go with the body, lifted by the highest ride (bit.js).
const RIDE_LIFT = 2;
const MOVED = {
  home: () => null,
  prop: () => null,
  ride: (f) => ({ dx: f.dx, dy: f.dy }),
};
const onRide = (f) => ({ ...f, dy: (f.dy || 0) - RIDE_LIFT });
const moverOf = (it) => MOVED[it.slot] || ((f) => f);

/** Ids of the clips in which these cells would leave the stage. */
export function clipsLeaving(cells, clipList = bit.clips, move = (f) => f) {
  return clipList.filter((c) => c.frames.some((f) => { const at = move(f); return !!at && leaves(cells, at); })).map((c) => c.id);
}

/** Tips (part of every Bit) stay on stage in every frame of every clip. */
export function checkTipStage() {
  return clipsLeaving(allTipCells()).map((id) => `tips leave the stage in ${id}`);
}

/* An item may be set down in a clip with a big move (bit.js does it), but
 * never in a mood clip, and in at most a few clips overall. */
const MAX_SET_DOWN = 3;

/** Every item keeps the wardrobe rules and shows in every mood pose. */
export function checkItems() {
  const problems = [];
  const ids = new Set();
  const tips = allTipCells();
  const moods = bit.clips.filter((c) => c.kind === 'mood');
  for (const it of wardrobe.ITEMS) {
    if (ids.has(it.id)) problems.push(`${it.id}: duplicate id`);
    ids.add(it.id);
    problems.push(...wardrobe.validate(it, tips).map((e) => `${it.id}: ${e}`));
    const cells = wardrobe.cellsOf(it);
    for (const id of clipsLeaving(cells, moods, moverOf(it))) problems.push(`${it.id}: leaves the stage in mood ${id}`);
    if (wardrobe.SLOTS.includes(it.slot)) for (const id of clipsLeaving(cells, moods, onRide)) problems.push(`${it.id}: leaves the stage on a ride in mood ${id}`);
    const down = clipsLeaving(cells, bit.clips, moverOf(it));
    if (down.length > MAX_SET_DOWN) problems.push(`${it.id}: set down in ${down.length} clips (${down.join(', ')})`);
  }
  return problems;
}

/** Items bit.js sets down, and in which clips: shown by the Lab, not an error. */
export function setDowns() {
  return wardrobe.ITEMS.map((it) => ({ id: it.id, clips: clipsLeaving(wardrobe.cellsOf(it), bit.clips, moverOf(it)) })).filter((x) => x.clips.length);
}

export function checkAll() {
  return [...checkColours(), ...checkPatterns(), ...checkTips(), ...checkTipStage(), ...checkItems()];
}
