// Xenon's marks, drawn from Bit's own sprite data. Pure: strings and pixel
// buffers out, nothing written, so build.mjs and the tests share one source.
//
// Rules (brand refresh, Oct 2026):
// - The mark IS Bit: body, open eyes and smile from packages/core, never redrawn.
// - Bit's real extent is 8x11 cells (grid columns 2..9, rows 0..10).
// - Small sizes use a whole number of screen pixels per Bit pixel, so they stay sharp.
// - The plate's corners are cut by one Bit pixel, the way Bit's own corners are.
// - In the lockup Bit stands on the baseline, his body is ~1.5x the x-height
//   and two Bit pixels separate him from the word.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { INK, MOOD_RGB, BODY, EYES, MOUTHS } = require('../../packages/core/src/bit-clips.js');
const { MODES } = require('../../packages/core/src/brand-tokens.js');
const WORDMARK = require('./wordmark.json');

const rgbHex = (triplet) => '#' + triplet.split(',').map((v) => Number(v).toString(16).padStart(2, '0')).join('');

// From the one brand set: neutral grey plate and word, Bit in his own green.
export const PALETTE = Object.freeze({
  bit: rgbHex(MOOD_RGB.happy), // Bit's "all good" green, on dark backgrounds
  // The same green deepened for light backgrounds: 3:1 down to the site's darkest
  // light grey (#CBCBCB), 5:1 on white.
  bitDeep: MODES.light.bit.ok,
  face: INK,
  plate: MODES.dark.surface[0],
  paper: MODES.light.surface[0],
  wordOnDark: MODES.dark.text[0],
  wordOnLight: MODES.light.text[0],
});

export const MARK_W = 8;
export const MARK_H = 11;
const GRID_X = 2; // Bit's body starts at column 2 of his 12-cell grid

// Screen pixels per Bit pixel at each square size. 24 has no plate: Bit fills it.
// 30..310 and 50 are the Windows tile and Store sizes the Tauri bundle asks for;
// the odd ones centre Bit to the nearest whole pixel. 96 is the notification badge.
export const ICON_UNIT = Object.freeze({
  16: 1, 24: 2, 30: 2, 32: 2, 44: 3, 48: 3, 50: 3, 64: 4, 71: 4, 89: 5, 96: 6, 107: 6,
  128: 8, 142: 8, 150: 9, 180: 12, 256: 16, 284: 16, 310: 18, 512: 32, 1024: 64,
});

/** Bit's cells cropped to his 8x11 box: [{ x, y, w, h, part }] with part 'body' or 'face'. */
export function markCells({ eyes = 'open' } = {}) {
  const crop = (cells, part) => cells.map(([x, y, w = 1, h = 1]) => ({ x: x - GRID_X, y, w, h, part }));
  const eyeCells = EYES[eyes];
  if (!eyeCells) throw new Error(`Unknown eyes: ${eyes}`);
  return [...crop(BODY, 'body'), ...crop(eyeCells, 'face'), ...crop(MOUTHS.smile, 'face')];
}

function rectsSvg(cells, colors, unit = 1, dx = 0, dy = 0) {
  return cells
    .map((c) => `<rect x="${c.x * unit + dx}" y="${c.y * unit + dy}" width="${c.w * unit}" height="${c.h * unit}" fill="${colors[c.part]}"/>`)
    .join('');
}

// One-colour Bit: the face is cut out of the body instead of painted on it.
function monoSvg(cells, color) {
  const id = 'bit-face';
  const face = cells.filter((c) => c.part === 'face');
  const body = cells.filter((c) => c.part === 'body');
  return (
    `<mask id="${id}"><rect width="${MARK_W}" height="${MARK_H}" fill="#fff"/>${rectsSvg(face, { face: '#000' })}</mask>` +
    `<g mask="url(#${id})">${rectsSvg(body, { body: color })}</g>`
  );
}

/**
 * Bit alone as an SVG on his 8x11 grid.
 * @param {{ body?: string, face?: string, mono?: string, eyes?: string, size?: number }} [o]
 *   mono: one colour with the face cut out; size: rendered height in px (default 88, 8 px per Bit pixel).
 */
export function markSvg(o = {}) {
  const cells = markCells({ eyes: o.eyes });
  const inner = o.mono ? monoSvg(cells, o.mono) : rectsSvg(cells, { body: o.body || PALETTE.bit, face: o.face || PALETTE.face });
  const h = o.size || MARK_H * 8;
  const w = (h * MARK_W) / MARK_H;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_W} ${MARK_H}" width="${w}" height="${h}" shape-rendering="crispEdges">${inner}</svg>\n`;
}

/** Placement of Bit inside a square icon, in whole screen pixels. */
export function iconLayout(size) {
  const u = ICON_UNIT[size];
  if (!u) throw new Error(`No icon unit for ${size}px; known sizes: ${Object.keys(ICON_UNIT).join(', ')}`);
  return { u, ox: Math.floor((size - MARK_W * u) / 2), oy: Math.floor((size - MARK_H * u) / 2), cut: u };
}

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/**
 * A square icon as RGBA pixels.
 * @param {number} size
 * @param {{ plate?: 'cut'|'full'|null, body?: string, face?: string|null }} [o]
 *   plate 'cut' (app icon, default), 'full' (Apple touch icon, the OS rounds it) or null (Bit alone);
 *   face null cuts the face out (a notification badge, which the OS draws from the alpha alone).
 */
export function iconRgba(size, o = {}) {
  const { u, ox, oy, cut } = iconLayout(size);
  const plate = o.plate === undefined ? 'cut' : o.plate;
  const data = new Uint8Array(size * size * 4);
  const fill = (x0, y0, w, h, hex) => {
    const px = hex === null ? [0, 0, 0, 0] : [...hexRgb(hex), 255];
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) data.set(px, (y * size + x) * 4);
  };
  if (plate === 'full') fill(0, 0, size, size, PALETTE.plate);
  if (plate === 'cut') {
    fill(cut, 0, size - 2 * cut, size, PALETTE.plate);
    fill(0, cut, size, size - 2 * cut, PALETTE.plate);
  }
  const colors = { body: o.body || PALETTE.bit, face: o.face === null ? null : o.face || PALETTE.face };
  for (const c of markCells()) fill(ox + c.x * u, oy + c.y * u, c.w * u, c.h * u, colors[c.part]);
  return { width: size, height: size, data };
}

/** Bit alone, cropped to his 8x11 box, `unit` screen pixels per Bit pixel (where SVG cannot go: email). */
export function markRgba(unit, o = {}) {
  const width = MARK_W * unit;
  const height = MARK_H * unit;
  const data = new Uint8Array(width * height * 4);
  const colors = { body: o.body || PALETTE.bit, face: o.face || PALETTE.face };
  for (const c of markCells()) {
    const px = [...hexRgb(colors[c.part]), 255];
    for (let y = c.y * unit; y < (c.y + c.h) * unit; y++) for (let x = c.x * unit; x < (c.x + c.w) * unit; x++) data.set(px, (y * width + x) * 4);
  }
  return { width, height, data };
}

/** Square SVG icon (favicon): the same plate and placement as the pixel icons, at 16px. */
export function iconSvg() {
  const { ox, oy } = iconLayout(16);
  const plate = `<path d="M1 0h14v1h1v14h-1v1H1v-1H0V1h1z" fill="${PALETTE.plate}"/>`;
  const bit = rectsSvg(markCells(), { body: PALETTE.bit, face: PALETTE.face }, 1, ox, oy);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">${plate}${bit}</svg>\n`;
}

// Lockup geometry, in Bit cells.
export const LOCKUP = Object.freeze({ xHeightCells: 5.5, gapCells: 2 });

/** Bit + "xenon" as one SVG with outlined letters. theme: 'dark' (for dark backgrounds) or 'light'. */
export function lockupSvg({ theme = 'dark', height = 88 } = {}) {
  const onDark = theme === 'dark';
  if (!onDark && theme !== 'light') throw new Error(`Unknown theme: ${theme}`);
  const s = LOCKUP.xHeightCells / WORDMARK.xHeight; // font units to cells
  const wordX = MARK_W + LOCKUP.gapCells - WORDMARK.ink.left * s;
  const width = round(MARK_W + LOCKUP.gapCells + (WORDMARK.ink.right - WORDMARK.ink.left) * s);
  // Exactly Bit's 11 rows tall, so heights that are multiples of 11 (22, 33, 44, 88) keep Bit sharp.
  // The round letters' overshoot below the baseline (~0.1 Bit pixel) is trimmed by the box.
  const viewH = MARK_H;
  const bit = rectsSvg(markCells(), { body: onDark ? PALETTE.bit : PALETTE.bitDeep, face: PALETTE.face });
  // Each glyph's path already carries its position along the word (see extract-wordmark.py).
  const letters = WORDMARK.glyphs.map((g) => `<path d="${g.d}"/>`).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${viewH}" width="${round((height * width) / viewH)}" height="${height}" role="img" aria-label="Xenon">` +
    `<g shape-rendering="crispEdges">${bit}</g>` +
    `<g fill="${onDark ? PALETTE.wordOnDark : PALETTE.wordOnLight}" transform="translate(${round(wordX)} ${MARK_H}) scale(${s})">${letters}</g>` +
    `</svg>\n`
  );
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}
