// The Buy Me a Coffee page's pictures: cover, tier and avatar. Writes one SVG
// each, drawn from Bit's own sprite data. Run: node tools/brand/bmc.mjs <folder>
// then shoot them with tools/brand/bmc-shoot.ps1 <folder>.
//
// How the page crops them (measured 6 Nov 2026, object-fit: cover):
// - cover: 6.0:1 from 1920 px up, 3.9:1 below, so only the middle 61% always
//   shows. The two page columns hide its lower fifth from 23% to 77% of the
//   width. On a phone the round avatar sits over the middle, from 42% down.
// - tier: 2.1:1 on a computer, 1.5:1 on a phone.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BODY, EYES, MOUTHS, CHEEKS, PARTS, MOOD_RGB } = require('../../packages/core/src/bit-clips.js');
const { MODES } = require('../../packages/core/src/brand-tokens.js');
const WORDMARK = require('./wordmark.json');
const DASHBOARD = { file: new URL('../../docs/images/home/edge-liquid.webp', import.meta.url), ratio: 720 / 2560 };
const PACKS = { file: new URL('../../server/assets/whatsnew/supporters.webp', import.meta.url), ratio: 920 / 960 };

const rgb = (mood) => '#' + MOOD_RGB[mood].split(',').map((v) => Number(v).toString(16).padStart(2, '0')).join('');

const C = Object.freeze({
  ink: MODES.dark.mainInk,
  bit: rgb('happy'),
  paper: '#f6f7f2',
  bezel: '#0b0d12',
});

// The Dusk wallpaper's own colours (server/assets/wallpapers/dusk.webp): the
// picture a new install opens on, so the page looks like the app.
const SKY = '#171c31';
const RINGS = ['#1c2340', '#32274f', '#4d2b58', '#7b3357', '#a93e4d', '#c95b43', '#cc7c49'];
const HILLS = ['#23465c', '#17334a', '#0e2232'];

const rect = (x, y, w, h, fill) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;

/** Bit on a grid of `u`, his 12-wide box starting at (x, y). `parts` are names from PARTS. */
function bit(x, y, u, { fill = C.bit, eyes = 'open', mouth = 'smile', cheeks = false, parts = [] }) {
  const cell = ([cx, cy, w = 1, h = 1], colour) => rect(x + cx * u, y + cy * u, w * u, h * u, colour);
  const shape = EYES[eyes];
  const extras = parts.map((name) => PARTS[name]);
  return [
    ...BODY.map((c) => cell(c, fill)),
    ...extras.flatMap((p) => p.cells.map((c) => cell(c, p.fill === 'body' ? fill : p.fill))),
    ...(Array.isArray(shape) ? shape : shape.cells).map((c) => cell(c, shape.fill || C.ink)),
    ...MOUTHS[mouth].map((c) => cell(c, C.ink)),
    ...(cheeks ? CHEEKS.cells.map((c) => cell(c, CHEEKS.fill)) : []),
  ].join('');
}

/** The small four-point star of Bit's own parts, at (x, y) on a grid of `u`. */
const star = (x, y, u, fill) => PARTS.star.cells.map(([cx, cy, w = 1]) => rect(x + cx * u, y + cy * u, w * u, u, fill)).join('');

/** The word, its x-height `h` tall, its left edge at x and the top of the letters at y. */
function word(x, y, h, fill) {
  const k = h / -WORDMARK.ink.top;
  // Each glyph's path already carries its position along the word.
  const paths = WORDMARK.glyphs.map((g) => `<path d="${g.d}"/>`).join('');
  return `<g fill="${fill}" transform="translate(${x - WORDMARK.ink.left * k} ${y + h}) scale(${k})">${paths}</g>`;
}

const wordWidth = (h) => (WORDMARK.ink.right - WORDMARK.ink.left) * (h / -WORDMARK.ink.top);

const pixels = (body) => `<g shape-rendering="crispEdges">${body}</g>`;

/** One hill across the picture, its top line at y, rising and falling by `swing`. */
function hill(w, h, y, swing, fill) {
  const d = `M0 ${y} C${w * 0.2} ${y - swing} ${w * 0.35} ${y - swing} ${w * 0.5} ${y} S${w * 0.8} ${y + swing} ${w} ${y} V${h} H0 Z`;
  return `<path d="${d}" fill="${fill}" filter="url(#cut)"/>`;
}

/** The sun at (x, y) in its rings over the sky, each ring `step` wider than the last. */
function dusk(w, h, x, y, sun, step, hills) {
  const rings = RINGS.map((fill, i) => `<circle cx="${x}" cy="${y}" r="${sun + (RINGS.length - 1 - i) * step}" fill="${fill}" filter="url(#cut)"/>`);
  return rect(0, 0, w, h, SKY) + rings.join('') + hills.map(([top, swing], i) => hill(w, h, top, swing, HILLS[i])).join('');
}

/** A real picture of the app in a thin bezel, on a foot. */
function display(x, y, w, foot, { file, ratio }) {
  const h = Math.round(w * ratio);
  const edge = Math.round(w / 90);
  const picture = `data:image/webp;base64,${fs.readFileSync(file).toString('base64')}`;
  return `<rect x="${x + w * 0.46}" y="${y + h}" width="${w * 0.08}" height="${foot}" fill="${C.bezel}"/>`
    + `<rect x="${x - edge}" y="${y - edge}" width="${w + 2 * edge}" height="${h + 2 * edge}" rx="${edge}" fill="${C.bezel}"/>`
    + `<image href="${picture}" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
}

function cover() {
  const W = 3840;
  const H = 600;
  const parts = [dusk(W, H, 1920, 480, 120, 150, [[470, 34], [525, 26], [572, 18]])];
  const h = 190;
  parts.push(word(800, 70, h, C.paper));
  // Above the row the page's columns hide, clear of the phone's round avatar.
  const top = 200;
  parts.push(display(2090, top, 960, 160, DASHBOARD));
  const u = 16;
  parts.push(pixels(bit(2800, top - 11 - 11 * u, u, { eyes: 'up', mouth: 'smile' })));
  return { name: 'cover', w: W, h: H, body: parts.join('') };
}

function tier() {
  const W = 1600;
  const H = 1067;
  const parts = [dusk(W, H, 1130, 790, 110, 130, [[790, 34], [890, 26], [985, 18]])];
  parts.push(display(840, 195, 580, 62, PACKS));
  const u = 26;
  parts.push(pixels(bit(235, 800 - 11 * u, u, { eyes: 'hearts', mouth: 'smile', parts: ['armsUp'] })));
  parts.push(word(120, 290, 118, C.paper));
  return { name: 'tier', w: W, h: H, body: parts.join('') };
}

function avatar() {
  const W = 1000;
  const u = 52;
  const parts = [dusk(W, W, 500, 500, 90, 90, [[835, 22], [905, 16], [960, 10]])];
  parts.push(pixels(bit(W / 2 - 6 * u, 835 - 11 * u + 8, u, {})));
  return { name: 'avatar', w: W, h: W, body: parts.join('') };
}

const page = ({ w, h, body }) => `<!doctype html><meta charset="utf-8"><style>html, body { margin: 0; } svg { display: block; }</style>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<filter id="cut" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0" dy="0" stdDeviation="${Math.round(w / 220)}" flood-color="#000" flood-opacity="0.3"/></filter>
${body}</svg>`;

const out = process.argv[2];
if (!out) { console.error('Usage: node tools/brand/bmc.mjs <folder>'); process.exit(1); }
fs.mkdirSync(out, { recursive: true });
for (const art of [cover(), tier(), avatar()]) {
  fs.writeFileSync(path.join(out, `${art.name}.html`), page(art));
  console.log(`${art.name} ${art.w} ${art.h}`);
}
