// Draws a Bit frame into an RGBA pixel buffer. Bit is only axis-aligned
// rectangles moved and scaled by one transform, so a tiny rasterizer gives
// pixel-exact output with no browser and no dependency.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bit = require('../../packages/core/src/bit.js');

const FLOOR_Y = 11;

export function parseColor(value) {
  const s = String(value).trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  m = /^rgb\((\d{1,3}),(\d{1,3}),(\d{1,3})\)$/.exec(s.replace(/\s+/g, ''));
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])].map((v) => Math.min(255, v));
  throw new Error(`Not a color: ${value} (use #rrggbb)`);
}

function blend(data, i, [r, g, b], a) {
  const da = data[i + 3] / 255;
  const oa = a + da * (1 - a);
  if (oa <= 0) return;
  data[i] = Math.round((r * a + data[i] * da * (1 - a)) / oa);
  data[i + 1] = Math.round((g * a + data[i + 1] * da * (1 - a)) / oa);
  data[i + 2] = Math.round((b * a + data[i + 2] * da * (1 - a)) / oa);
  data[i + 3] = Math.round(oa * 255);
}

// Stage units to pixel edges; Math.round keeps neighbouring cells seamless.
function span(a, b, origin, scale, max) {
  const lo = Math.round((Math.min(a, b) - origin) * scale);
  const hi = Math.round((Math.max(a, b) - origin) * scale);
  return [Math.max(0, lo), Math.min(max, hi)];
}

/**
 * @param {string|object} clip   clip id or clip
 * @param {number} index         frame index
 * @param {{ scale?: number, background?: string|null, tint?: string }} [opts]
 * @returns {{ width: number, height: number, data: Uint8Array }}
 */
export function rasterFrame(clip, index, opts = {}) {
  const scale = opts.scale || 16;
  const { STAGE } = bit;
  const width = STAGE.w * scale;
  const height = STAGE.h * scale;
  const data = new Uint8Array(width * height * 4);
  if (opts.background) {
    const [r, g, b] = parseColor(opts.background);
    for (let i = 0; i < data.length; i += 4) data.set([r, g, b, 255], i);
  }
  const floorPx = Math.round((FLOOR_Y - STAGE.y) * scale);
  for (const layer of bit.renderFrame(clip, index, { tint: opts.tint }).layers) {
    const t = layer.transform;
    const sx = t ? t.sx : 1;
    const sy = t ? t.sy : 1;
    const tx = t ? t.dx + t.px - t.px * t.sx : 0;
    const ty = t ? t.dy + t.py - t.py * t.sy : 0;
    const yMax = layer.clipFloor ? floorPx : height;
    for (const r of layer.rects) {
      const color = parseColor(r.fill);
      const [x0, x1] = span(tx + sx * r.x, tx + sx * (r.x + r.w), STAGE.x, scale, width);
      const [y0, y1] = span(ty + sy * r.y, ty + sy * (r.y + r.h), STAGE.y, scale, yMax);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) blend(data, (y * width + x) * 4, color, r.o);
      }
    }
  }
  return { width, height, data };
}

export { bit };
