import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ICON_UNIT, LOCKUP, MARK_H, MARK_W, PALETTE, iconLayout, iconRgba, iconSvg, lockupSvg, markCells, markSvg,
} from '../../tools/brand/mark.mjs';
import { encodeIco } from '../../tools/brand/ico.mjs';
import {
  APP_ICON_SIZES, BARE_SIZES, FIXED_PATHS, ICO_SIZES, TAURI_ICONS, TAURI_ICO_SIZES, brandFiles, fixedPathFiles, tauriIconFiles,
  writeBrand,
} from '../../tools/brand/build.mjs';

const require = createRequire(import.meta.url);
const { BODY, EYES, MOUTHS, INK } = require('../../packages/core/src/bit-clips.js');
const WORDMARK = require('../../tools/brand/wordmark.json');

const hex = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  const [r, g, b, a] = img.data.subarray(i, i + 4);
  return a === 0 ? null : '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
};
const luminance = (h) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

test('the mark is Bit from packages/core, cell for cell, never redrawn', () => {
  const key = ([x, y, w = 1, h = 1]) => `${x - 2},${y},${w},${h}`;
  const cells = markCells();
  assert.deepEqual(cells.filter((c) => c.part === 'body').map((c) => `${c.x},${c.y},${c.w},${c.h}`), BODY.map(key));
  assert.deepEqual(cells.filter((c) => c.part === 'face').map((c) => `${c.x},${c.y},${c.w},${c.h}`), [...EYES.open, ...MOUTHS.smile].map(key));
  assert.ok(markCells({ eyes: 'blink' }).some((c) => c.part === 'face'), 'the blink frame exists');
  assert.throws(() => markCells({ eyes: 'nope' }), /Unknown eyes/);
  for (const c of cells) assert.ok(c.x >= 0 && c.x + c.w <= MARK_W && c.y >= 0 && c.y + c.h <= MARK_H, `cell inside 8x11: ${JSON.stringify(c)}`);
  assert.equal(PALETTE.face, INK);
});

test('the logo wears the one brand set: neutral plate and word, Bit in green', async () => {
  const { createRequire } = await import('node:module');
  const { MODES } = createRequire(import.meta.url)('../../packages/core/src/brand-tokens.js');
  assert.equal(PALETTE.plate, MODES.dark.surface[0]);
  assert.equal(PALETTE.paper, MODES.light.surface[0]);
  assert.equal(PALETTE.wordOnDark, MODES.dark.text[0]);
  assert.equal(PALETTE.wordOnLight, MODES.light.text[0]);
  assert.equal(PALETTE.bitDeep, MODES.light.bit.ok);
});

test('each green holds 3:1 against the background it is made for', () => {
  assert.ok(contrast(PALETTE.bit, PALETTE.plate) >= 3, 'bright green on charcoal');
  assert.ok(contrast(PALETTE.bitDeep, PALETTE.paper) >= 3, 'deep green on paper');
  assert.ok(contrast(PALETTE.bitDeep, '#ffffff') >= 3, 'deep green on white (email, GitHub light)');
  // The site's light greys, page to scrolled header (docs/site.css, docs/index.html).
  for (const grey of ['#EFEFEF', '#E4E4E4', '#D8D8D8', '#CBCBCB']) {
    assert.ok(contrast(PALETTE.bitDeep, grey) >= 3, `deep green on the site's ${grey}`);
  }
  assert.ok(contrast(PALETTE.bit, PALETTE.paper) < 3, 'why the deep green exists');
  assert.ok(contrast(PALETTE.face, PALETTE.bitDeep) >= 3, 'the face still reads on the deep green');
});

test('every icon size puts whole screen pixels under every Bit pixel', () => {
  for (const size of Object.keys(ICON_UNIT).map(Number)) {
    const { u, ox, oy } = iconLayout(size);
    assert.ok(Number.isInteger(u) && Number.isInteger(ox) && Number.isInteger(oy), `${size}: integer layout`);
    assert.ok(ox >= 0 && oy >= 0 && ox + MARK_W * u <= size && oy + MARK_H * u <= size, `${size}: Bit fits`);
  }
  assert.throws(() => iconLayout(20), /No icon unit/);
});

test('icons contain only the palette colours: no blur, no stray pixels', () => {
  const allowed = new Set([PALETTE.plate, PALETTE.bit, PALETTE.face, null]);
  for (const size of APP_ICON_SIZES) {
    const img = iconRgba(size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) assert.ok(allowed.has(hex(img, x, y)), `${size} at ${x},${y}: ${hex(img, x, y)}`);
  }
});

test('the plate corners are cut by one Bit pixel and the antenna sits where the sprite says', () => {
  for (const size of [16, 48, 256]) {
    const img = iconRgba(size);
    const { u, ox, oy } = iconLayout(size);
    assert.equal(hex(img, 0, 0), null, `${size}: corner cut`);
    assert.equal(hex(img, u - 1, u - 1), null, `${size}: the whole Bit pixel is cut`);
    assert.equal(hex(img, u, 0), PALETTE.plate, `${size}: the plate starts right after`);
    assert.equal(hex(img, ox + 4 * u, oy), PALETTE.bit, `${size}: antenna (column 6 of the grid)`);
    assert.equal(hex(img, ox + 2 * u, oy + 4 * u), PALETTE.face, `${size}: left eye`);
  }
  const bare = iconRgba(24, { plate: null });
  assert.equal(hex(bare, 0, 12), null, 'no plate: transparent around Bit');
  const full = iconRgba(180, { plate: 'full' });
  assert.equal(hex(full, 0, 0), PALETTE.plate, 'Apple icon is full bleed, the OS rounds it');
});

test('the lockup: outlined letters, Bit on the baseline, sized from the x-height', () => {
  for (const theme of ['dark', 'light']) {
    const svg = lockupSvg({ theme });
    assert.doesNotMatch(svg, /<text/, 'no live text: it must not depend on a font');
    assert.match(svg, new RegExp(`viewBox="0 0 [\\d.]+ ${MARK_H}"`), 'exactly 11 Bit rows tall');
    assert.equal((svg.match(/<path d=/g) || []).length, WORDMARK.word.length);
    assert.match(svg, /role="img" aria-label="Xenon"/);
    assert.match(svg, new RegExp(`translate\\([\\d.]+ ${MARK_H}\\)`), 'letters sit on the line Bit stands on');
  }
  assert.match(lockupSvg({ theme: 'dark' }), new RegExp(PALETTE.bit));
  assert.match(lockupSvg({ theme: 'light' }), new RegExp(PALETTE.bitDeep));
  assert.throws(() => lockupSvg({ theme: 'blue' }), /Unknown theme/);
  const s = Number(/scale\(([\d.e-]+)\)/.exec(lockupSvg())[1]);
  assert.ok(Math.abs(WORDMARK.xHeight * s - LOCKUP.xHeightCells) < 1e-9);
  assert.ok(8 / LOCKUP.xHeightCells > 1.4 && 8 / LOCKUP.xHeightCells < 1.6, "Bit's body ~1.5x the x-height");
});

test('the wordmark data is the word, left to right, on the baseline', () => {
  assert.equal(WORDMARK.glyphs.map((g) => g.char).join(''), 'xenon');
  const xs = WORDMARK.glyphs.map((g) => g.x);
  assert.deepEqual([...xs].sort((a, b) => a - b), xs);
  assert.ok(WORDMARK.ink.bottom < 20 && WORDMARK.ink.top < 0, 'baseline at y=0, letters above it');
});

test('marks and favicon SVGs are crisp and use the brand colours', () => {
  assert.match(markSvg(), /shape-rendering="crispEdges"/);
  assert.match(markSvg({ body: PALETTE.bitDeep }), new RegExp(PALETTE.bitDeep));
  const mono = markSvg({ mono: '#000000' });
  assert.match(mono, /<mask id="bit-face">/, 'one colour: the face is a hole, not a second colour');
  assert.doesNotMatch(mono, new RegExp(PALETTE.bit));
  const fav = iconSvg();
  assert.match(fav, /viewBox="0 0 16 16"/);
  assert.match(fav, new RegExp(PALETTE.plate));
});

test('the .ico holds each size as a PNG with the right directory entries', () => {
  const pngs = [16, 256].map((size) => ({ size, png: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, size & 255]) }));
  const ico = encodeIco(pngs);
  const v = new DataView(ico.buffer);
  assert.equal(v.getUint16(2, true), 1);
  assert.equal(v.getUint16(4, true), 2);
  assert.equal(ico[6], 16);
  assert.equal(ico[6 + 16], 0, '256 is written as 0');
  const second = v.getUint32(6 + 16 + 12, true);
  assert.equal(second, 6 + 32 + 5);
  assert.equal(ico[second + 4], 0);
  assert.throws(() => encodeIco([]), /at least one/);
  assert.throws(() => encodeIco([{ size: 512, png: new Uint8Array(1) }]), /out of range/);
});

test('build writes the full set, and the set lists every size it promises', async () => {
  const names = brandFiles().map((f) => f.name);
  for (const size of APP_ICON_SIZES) assert.ok(names.includes(`icon-${size}.png`));
  for (const size of BARE_SIZES) assert.ok(names.includes(`bit-${size}.png`) && names.includes(`bit-${size}-light.png`));
  for (const n of ['bit.svg', 'bit-light.svg', 'bit-mono.svg', 'bit-blink.svg', 'xenon-logo-dark.svg', 'xenon-logo-light.svg', 'favicon.svg', 'favicon.ico', 'bit-4x.png', 'apple-touch-icon.png']) {
    assert.ok(names.includes(n), n);
  }
  assert.deepEqual(ICO_SIZES.filter((s) => s > 256), []);
  const dir = await mkdtemp(path.join(tmpdir(), 'xenon-brand-'));
  try {
    await writeBrand(dir);
    assert.deepEqual((await readdir(dir)).sort(), [...names].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the native app icons: every flat file the bundle ships, drawn pixel-exact', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const conf = JSON.parse(await readFile(path.join(root, 'apps/native/src-tauri/tauri.conf.json'), 'utf8'));
  const files = tauriIconFiles();
  const names = files.map((f) => f.name);
  for (const icon of conf.bundle.icon.filter((i) => !i.endsWith('.icns'))) {
    assert.ok(names.includes(path.basename(icon)), `${icon} is written`);
  }
  const committed = (await readdir(path.join(root, 'apps/native/src-tauri/icons'))).filter((n) => /\.(png|ico)$/.test(n));
  assert.deepEqual([...names].sort(), committed.sort(), 'the same set as apps/native/src-tauri/icons');
  const allowed = new Set([PALETTE.plate, PALETTE.bit, PALETTE.face, null]);
  for (const size of Object.values(TAURI_ICONS)) {
    assert.ok(ICON_UNIT[size], `${size} has a unit`);
    const img = iconRgba(size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) assert.ok(allowed.has(hex(img, x, y)), `${size} at ${x},${y}`);
  }
  const ico = files.find((f) => f.name === 'icon.ico').bytes;
  assert.equal(new DataView(ico.buffer, ico.byteOffset).getUint16(4, true), TAURI_ICO_SIZES.length, 'icon.ico holds every size');
});

test('the fixed-path logo files in the repo are the ones the tool draws', async () => {
  // The site, the README, sent emails and the app load these by path; a stale one
  // would bring the old logo back without anyone touching a page.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (const f of fixedPathFiles()) {
    assert.ok(Buffer.from(f.bytes).equals(await readFile(path.join(root, f.name))), `${f.name} is up to date (node tools/brand/build.mjs --fixed)`);
  }
  const badge = iconRgba(96, { plate: null, body: '#ffffff', face: null });
  const { u, ox, oy } = iconLayout(96);
  assert.equal(hex(badge, ox + 4 * u, oy), '#ffffff', 'badge: Bit in white');
  assert.equal(hex(badge, ox + 2 * u, oy + 4 * u), null, 'badge: the eye is a hole');
  assert.ok(Object.keys(FIXED_PATHS).every((p) => !p.startsWith('/') && !p.includes('..')), 'paths stay inside the repo');
});

// The site names the Scintille that come with a plan: it shows the app's own
// spark, still, from the shared engine, so the two never drift apart.
test('the Scintilla ships as spark.svg, the shared engine\'s still frame', () => {
  const spark = brandFiles().find((f) => f.name === 'spark.svg');
  assert.ok(spark, 'spark.svg is in the set');
  const engine = require('../../packages/core/src/bit-spark.js').svg({ still: true });
  assert.equal(spark.bytes.toString('utf8'), engine.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '), 'with the namespace a file needs to show in <img>');
  assert.match(spark.bytes.toString('utf8'), /shape-rendering="crispEdges"/);
});
