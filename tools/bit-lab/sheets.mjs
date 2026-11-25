// The Bit Lab's contact sheets: PNG grids (and one GIF) of personal Bits, to
// judge the look by eye. Every sheet is built from fixed seeds, so the same
// command draws the same sheet until the genes or the engine change.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { encodePng } from '../bit-export/png.mjs';
import { encodeGif } from '../bit-export/gif.mjs';
import { createRequire } from 'node:module';
import { labSeeds, bitTile, grid, THEMES, genome, wardrobe, bit } from './lab.mjs';

const need = createRequire(import.meta.url);
const G = need('../../packages/core/src/bit-genes.js');
const LIFE = need('../../packages/core/src/bit-clips-life.js');

// "6 Bits of 6 people": the item each one earns by how they use their PC.
export const PEOPLE = Object.freeze([
  ['gamer', 'headset'],
  ['night owl', 'nightcap'],
  ['music lover', 'earbuds'],
  ['programmer', 'glasses'],
  ['early riser', 'mug'],
  ['collector', 'backpack'],
]);

const GAP = 8;
const sheet = (tiles, cols, theme = 'dark') => encodePng(grid(tiles, cols, GAP, THEMES[theme]));
const genesOf = (seed, change) => ({ ...genome.decode(seed), ...change });

/** Every sheet as [file name, bytes]. `base` picks the random Bits. */
export function buildSheets(base = 'lab') {
  const files = [];
  const random = labSeeds(64, base);
  for (const theme of ['dark', 'light']) files.push([`random-${theme}.png`, sheet(random.map((s) => bitTile(s, { theme })), 8, theme)]);

  const people = labSeeds(PEOPLE.length, `${base}:people`);
  const peopleTiles = (theme) => people.map((s, k) => bitTile(s, { theme, worn: [PEOPLE[k][1]], scale: 12 }));
  files.push(['people.png', sheet(peopleTiles('dark'), 6)], ['people-light.png', sheet(peopleTiles('light'), 6, 'light')]);

  const [one] = labSeeds(1, `${base}:one`);
  // one Bit in a fixed violet, so a single trait changes at a time (and classic green stands out)
  const variant = (change) => bitTile(one, { genes: genesOf(one, { palette: 'violet-pastel', pattern: 'plain', patternColor: 'none', ...change }), scale: 10 });
  files.push(['tips.png', sheet(G.TIPS.map((t) => variant({ tip: t.id })), 8)]);
  files.push(['patterns.png', sheet(G.PATTERNS.map((p) => variant({ pattern: p.id, patternColor: p.role === 'mark' ? 'accent' : p.role })), 8)]);
  files.push(['palettes.png', sheet(genome.PALETTES.map((p) => bitTile(one, { genes: genesOf(one, { palette: p.id }), scale: 6 })), 16)]);
  files.push(['rare.png', sheet([variant({ palette: 'classic', classic: true }), variant({ shiny: true }), variant({ cheeks: 'freckles' }), variant({ pattern: 'face', patternColor: 'cream' })], 4)]);

  const dressed = labSeeds(wardrobe.ITEMS.length, `${base}:wardrobe`);
  files.push(['wardrobe.png', sheet(wardrobe.ITEMS.map((it, k) => bitTile(dressed[k], { worn: [it.id], scale: 10 })), 10)]);

  const moods = bit.clips.filter((c) => c.kind === 'mood');
  files.push(['moods.png', sheet(moods.map((c) => bitTile(one, { clip: c.id, scale: 10 })), moods.length)]);

  // The life pack's moments: one row each, frames left to right (the last one repeated to fill the row).
  const moments = LIFE.CLIPS.filter((c) => c.id !== 'hatch');
  const COLS = 10;
  const row = (c) => Array.from({ length: COLS }, (_, i) => bitTile(one, { clip: c.id, frame: Math.min(i, c.frames.length - 1), scale: 6 }));
  files.push(['moments.png', sheet(moments.flatMap(row), COLS)]);

  const hatch = bit.clip('hatch');
  const frames = hatch.frames.map((f, i) => ({ ...bitTile(one, { clip: 'hatch', frame: i, scale: 10 }), ms: f.ms }));
  files.push(['hatch.gif', encodeGif(frames)]);
  return files;
}

export async function writeSheets(outDir, base) {
  await mkdir(outDir, { recursive: true });
  const written = [];
  for (const [name, bytes] of buildSheets(base)) {
    const file = path.join(outDir, name);
    await writeFile(file, bytes);
    written.push(file);
  }
  return written;
}
