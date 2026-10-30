// Xenon's one loader: a Bit clip as an SVG that animates itself. Pure:
// strings out, nothing written, so build.mjs and the tests share one source.
//
// Why a self-animating file and not the live player: it needs no script, so
// it shows before any script has run (the boot splash, the native splash),
// works as an <img> or a CSS background on the site and in the Maker, and
// costs no timer per loader in the dashboard.
//
// Every frame is a group; CSS keyframes show each one for its own slice of the
// clip. Without motion (reduced motion, or a browser that ignores the
// animation) the still frame stays: the same pose the live player rests on.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bit = require('../../packages/core/src/bit.js');
const { stillIndex } = require('../../packages/core/src/bit-player.js');

const FLOOR_Y = 11; // Bit's feet; the body is clipped above it (see bit.js)

const round = (n) => Math.round(n * 1000) / 1000;

function placed(rect, t) {
  if (!t) return rect;
  const tx = t.dx + t.px - t.px * t.sx;
  const ty = t.dy + t.py - t.py * t.sy;
  return { x: tx + rect.x * t.sx, y: ty + rect.y * t.sy, w: rect.w * t.sx, h: rect.h * t.sy };
}

/** The whole-cell box every frame of the clips fits in: { x, y, w, h }. */
export function clipBox(...clipIds) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const clipId of clipIds) {
    const c = bit.clip(clipId);
    if (!c) throw new Error(`Unknown clip: ${clipId}`);
    c.frames.forEach((_, i) => {
      for (const layer of bit.renderFrame(c, i).layers) {
        for (const r of layer.rects) {
          const p = placed(r, layer.transform);
          const bottom = layer.clipFloor ? Math.min(p.y + p.h, FLOOR_Y) : p.y + p.h;
          x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
          x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, bottom);
        }
      }
    });
  }
  const x = Math.floor(x0), y = Math.floor(y0);
  return { x, y, w: Math.ceil(x1) - x, h: Math.ceil(y1) - y };
}

function frameGroup(c, i) {
  const { layers } = bit.renderFrame(c, i);
  const body = layers.map((l) => {
    const rs = l.rects
      .map((r) => `<rect x="${round(r.x)}" y="${round(r.y)}" width="${round(r.w)}" height="${round(r.h)}" fill="${r.fill}"${r.o < 1 ? ` opacity="${round(r.o)}"` : ''}/>`)
      .join('');
    const tr = bit.transformAttr(l.transform);
    const g = `<g${tr ? ` transform="${tr}"` : ''}>${rs}</g>`;
    return l.clipFloor ? `<g clip-path="url(#floor)">${g}</g>` : g;
  });
  return `<g class="f" id="f${i}">${body.join('')}</g>`;
}

/** Where each frame starts and ends, as percentages of the clip. */
export function frameSlices(clipId) {
  const c = bit.clip(clipId);
  const total = bit.duration(c);
  let at = 0;
  return c.frames.map((f) => {
    const slice = { from: round((at / total) * 100), to: round(((at + f.ms) / total) * 100) };
    at += f.ms;
    return slice;
  });
}

function keyframes(clipId, once) {
  const slices = frameSlices(clipId);
  const last = slices.length - 1;
  return slices
    .map(({ from, to }, i) => {
      const steps = [];
      if (from > 0) steps.push('0%{opacity:0}');
      steps.push(`${from}%{opacity:1}`);
      // Played once, the last frame stays on screen when the clip ends.
      if (to < 100 || !(once && i === last)) steps.push(`${to}%{opacity:0}`);
      if (to < 100) steps.push('100%{opacity:0}');
      if (once && i === last) steps.push('100%{opacity:1}');
      return `@keyframes f${i}{${steps.join('')}}`;
    })
    .join('');
}

/**
 * A clip as a standalone, self-animating SVG.
 * @param {string} clipId  a clip from packages/core/src/bit-clips.js
 * @param {object} o       { unit: screen px per Bit pixel, once: play one time, still: no animation at all,
 *                          stage: clip ids whose box this one shares, so swapping files never moves Bit }
 */
export function clipSvg(clipId, { unit = 4, once = false, still = false, stage = [clipId] } = {}) {
  const c = bit.clip(clipId);
  if (!c) throw new Error(`Unknown clip: ${clipId}`);
  const box = clipBox(...stage);
  const rest = once ? c.frames.length - 1 : stillIndex(c);
  const groups = still ? [frameGroup(c, rest).replace(`id="f${rest}"`, 'id="still"')] : c.frames.map((_, i) => frameGroup(c, i));
  const run = c.frames
    .map((_, i) => `#f${i}{animation:f${i} ${bit.duration(c)}ms step-end ${once ? '1 forwards' : 'infinite'}}`)
    .join('');
  const style = still
    ? ''
    : `<style>.f{opacity:0}#f${rest}{opacity:1}@media (prefers-reduced-motion:no-preference){${run}}${keyframes(clipId, once)}</style>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.x} ${box.y} ${box.w} ${box.h}" width="${box.w * unit}" height="${box.h * unit}" shape-rendering="crispEdges">` +
    style +
    `<defs><clipPath id="floor"><rect x="${box.x}" y="${box.y}" width="${box.w}" height="${FLOOR_Y - box.y}"/></clipPath></defs>` +
    groups.join('') +
    '</svg>'
  );
}

const BOOT_STAGE = ['recharge', 'hello'];

// The loader set: which clip plays where.
export const LOADER_FILES = Object.freeze({
  'bit-think.svg': { clip: 'think' },            // tiles, panels, buttons
  'bit-think-still.svg': { clip: 'think', still: true }, // the dashboard's frozen states
  // Starting up, then ready: the boot splash swaps one for the other in place.
  'bit-recharge.svg': { clip: 'recharge', stage: BOOT_STAGE },
  'bit-hello.svg': { clip: 'hello', once: true, stage: BOOT_STAGE },
  'bit-recharge-still.svg': { clip: 'recharge', still: true, stage: BOOT_STAGE }, // starting up, without motion
});

/** The loader files as { name, bytes }; nothing is written. */
export function loaderFiles() {
  return Object.entries(LOADER_FILES).map(([name, o]) => ({ name, bytes: Buffer.from(clipSvg(o.clip, o), 'utf8') }));
}
