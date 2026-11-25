// Shared helpers of the Bit Lab: seeds, one rendered Bit, and a grid of them.
// Everything is drawn by the app's own engine (packages/core) through the
// export tool's rasterizer, so what the Lab shows is what the app will draw.
import { createRequire } from 'node:module';
import { rasterFrame, parseColor } from '../bit-export/raster.mjs';

const require = createRequire(import.meta.url);
export const genome = require('../../packages/core/src/bit-genome.js');
export const looks = require('../../packages/core/src/bit-look.js');
export const wardrobe = require('../../packages/core/src/bit-wardrobe.js');
export const bit = require('../../packages/core/src/bit.js');

export const THEMES = Object.freeze({ dark: '#0b0f14', light: '#f4f6f5' });

const hex8 = (n) => Math.floor(n * 4294967296).toString(16).padStart(8, '0');

/** `count` seeds, the same for the same `base`: a sheet can be redrawn exactly. */
export function labSeeds(count, base = 'lab') {
  const rand = genome.stream('0000000000000000', `bit-lab:${base}`);
  return Array.from({ length: count }, () => hex8(rand()) + hex8(rand()));
}

/**
 * One Bit as RGBA pixels.
 * @param {string} seed
 * @param {{clip?: string, frame?: number, scale?: number, theme?: string, worn?: string[], genes?: object}} [o]
 *   genes: decoded genes to draw instead of the seed's (to show one trait at a time)
 */
export function bitTile(seed, o = {}) {
  const genes = o.genes || genome.decode(seed);
  const background = THEMES[o.theme || 'dark'];
  const look = looks.lookOf(genes, { worn: wardrobe.outfit(o.worn || []), background });
  return rasterFrame(o.clip || 'idle', o.frame || 0, { scale: o.scale || 8, background, look });
}

/** Images of the same size in rows of `cols`, `gap` pixels apart. */
export function grid(images, cols, gap, background) {
  const { width, height } = images[0];
  const rows = Math.ceil(images.length / cols);
  const W = cols * width + (cols + 1) * gap;
  const H = rows * height + (rows + 1) * gap;
  const data = new Uint8Array(W * H * 4);
  const [r, g, b] = parseColor(background);
  for (let i = 0; i < data.length; i += 4) data.set([r, g, b, 255], i);
  images.forEach((img, k) => {
    const x0 = gap + (k % cols) * (width + gap);
    const y0 = gap + Math.floor(k / cols) * (height + gap);
    for (let y = 0; y < height; y++) data.set(img.data.subarray(y * width * 4, (y + 1) * width * 4), ((y0 + y) * W + x0) * 4);
  });
  return { width: W, height: H, data };
}
