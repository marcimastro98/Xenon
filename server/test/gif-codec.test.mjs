// The GIF reader and writer that keep moving pictures moving: a canvas only
// draws a GIF's first frame, so the animated background reads the frames with
// GifRead, and editors make a too-big GIF smaller with GifWrite. These pin that
// what we write reads back pixel for pixel, that real-world GIF features
// (disposal, transparency, interlacing, local palettes) read the way browsers
// show them, and that a shrink really fits its budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const GifRead = require('../js/gif-read.js');
const GifWrite = require('../js/gif-write.js');

// A frame of w x h filled by fn(x, y) -> [r, g, b, a].
function frame(w, h, fn, delay = 100) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data.set(fn(x, y), (y * w + x) * 4);
  }
  return { data, delay };
}

const px = (anim, f, x, y) => [...anim.frames[f].data.subarray((y * anim.width + x) * 4, (y * anim.width + x) * 4 + 4)];

test('what the writer writes, the reader reads back exactly (few colours)', () => {
  const colors = [[255, 0, 0, 255], [0, 0, 255, 255], [0, 255, 0, 255]];
  const anim = { width: 20, height: 12, loop: 0, frames: colors.map((c, i) => frame(20, 12, (x) => (x < 10 ? c : colors[(i + 1) % 3]), 80 + i * 10)) };
  const back = GifRead.decodeGif(GifWrite.encodeGif(anim));
  assert.equal(back.width, 20);
  assert.equal(back.height, 12);
  assert.equal(back.loop, 0);
  assert.deepEqual(back.frames.map(f => f.delay), [80, 90, 100]);
  for (let f = 0; f < 3; f++) {
    assert.deepEqual(px(back, f, 2, 5), colors[f]);
    assert.deepEqual(px(back, f, 15, 5), colors[(f + 1) % 3]);
  }
});

test('a large noisy picture survives the LZW table filling and restarting', () => {
  // 200x200 of 200 distinct colours in a pseudo-random order: far more than
  // 4096 codes, so the table clears several times.
  let seed = 7;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) % 200;
  const pal = Array.from({ length: 200 }, (_, i) => [i, 255 - i, (i * 7) & 255, 255]);
  const cells = Array.from({ length: 200 * 200 }, rand);
  const anim = { width: 200, height: 200, loop: 0, frames: [frame(200, 200, (x, y) => pal[cells[y * 200 + x]])] };
  const back = GifRead.decodeGif(GifWrite.encodeGif(anim));
  let wrong = 0;
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 200; x++) {
      const want = pal[cells[y * 200 + x]];
      const got = px(back, 0, x, y);
      if (Math.abs(got[0] - want[0]) + Math.abs(got[1] - want[1]) + Math.abs(got[2] - want[2]) > 0) wrong++;
    }
  }
  assert.equal(wrong, 0);
});

test('frames that only change a corner are stored small and still read whole', () => {
  const W = 64, H = 64;
  const base = (x, y) => [(x * 4) & 255, (y * 4) & 255, 128, 255];
  const frames = [frame(W, H, base)];
  for (let i = 1; i < 6; i++) frames.push(frame(W, H, (x, y) => (x < 8 && y < 8 ? [255, i * 40, 0, 255] : base(x, y))));
  const anim = { width: W, height: H, loop: 0, frames };
  const bytes = GifWrite.encodeGif(anim);
  const back = GifRead.decodeGif(bytes);
  assert.equal(back.frames.length, 6);
  for (let f = 1; f < 6; f++) {
    assert.deepEqual(px(back, f, 3, 3), px(back, f, 3, 3)); // sanity
    assert.equal(px(back, f, 3, 3)[0] > 200, true);
    assert.deepEqual(px(back, f, 40, 40), px(back, 0, 40, 40));
  }
  // Six whole frames would be several times bigger than one plus five corners.
  const whole = GifWrite.encodeGif({ ...anim, frames: [frames[0]] }).length;
  assert.ok(bytes.length < whole * 2, `${bytes.length} vs one frame ${whole}`);
});

test('see-through pictures keep their holes in every frame', () => {
  const anim = {
    width: 10, height: 10, loop: 0,
    frames: [
      frame(10, 10, (x) => (x < 5 ? [255, 0, 0, 255] : [0, 0, 0, 0])),
      frame(10, 10, (x) => (x >= 5 ? [0, 0, 255, 255] : [0, 0, 0, 0])),
    ],
  };
  const back = GifRead.decodeGif(GifWrite.encodeGif(anim));
  assert.equal(px(back, 0, 2, 2)[3], 255);
  assert.equal(px(back, 0, 7, 2)[3], 0);
  // The second frame replaces the first: the red half is gone.
  assert.equal(px(back, 1, 2, 2)[3], 0);
  assert.deepEqual(px(back, 1, 7, 2), [0, 0, 255, 255]);
});

// Hand-built GIF pieces for features our writer never uses.
function lzwRaw(indices, minSize) {
  // Clear before every second code keeps the width fixed at minSize + 1.
  const clear = 1 << minSize, eoi = clear + 1, size = minSize + 1;
  const out = [];
  let acc = 0, bits = 0;
  const put = c => { acc |= c << bits; bits += size; while (bits >= 8) { out.push(acc & 255); acc >>= 8; bits -= 8; } };
  put(clear);
  indices.forEach((v, i) => { put(v); if (i % 2) put(clear); });
  put(eoi);
  if (bits) out.push(acc & 255);
  const sub = [];
  for (let i = 0; i < out.length; i += 255) { const c = out.slice(i, i + 255); sub.push(c.length, ...c); }
  sub.push(0);
  return sub;
}
const u16 = v => [v & 255, v >> 8];
const head = (w, h, pal) => [...Buffer.from('GIF89a'), ...u16(w), ...u16(h), 0x80 | (Math.log2(pal.length / 3) - 1), 0, 0, ...pal];
const gce = (disposal, delayCs, trans = -1) => [0x21, 0xf9, 4, (disposal << 2) | (trans >= 0 ? 1 : 0), ...u16(delayCs), Math.max(0, trans), 0];
const img = (l, t, w, h, indices, flags = 0, lct = []) => [0x2c, ...u16(l), ...u16(t), ...u16(w), ...u16(h), flags, ...lct, 2, ...lzwRaw(indices, 2)];
const PAL4 = [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255];

test('disposal "restore to background" and "restore to previous" read as browsers show them', () => {
  const bytes = Uint8Array.from([
    ...head(4, 1, PAL4),
    ...gce(0, 10), ...img(0, 0, 4, 1, [1, 1, 1, 1]),
    ...gce(2, 10), ...img(0, 0, 2, 1, [2, 2]), // drawn, then cleared
    ...gce(3, 10), ...img(2, 0, 2, 1, [3, 3]), // drawn, then put back as before
    ...gce(0, 10), ...img(3, 0, 1, 1, [2]),
    0x3b,
  ]);
  const a = GifRead.decodeGif(bytes);
  assert.equal(a.frames.length, 4);
  assert.deepEqual(px(a, 1, 0, 0), [0, 255, 0, 255]);
  assert.equal(px(a, 2, 0, 0)[3], 0, 'frame 2 sees frame 1 cleared');
  assert.deepEqual(px(a, 2, 2, 0), [0, 0, 255, 255]);
  assert.deepEqual(px(a, 3, 2, 0), [255, 0, 0, 255], 'frame 3 sees frame 2 undone');
  assert.deepEqual(px(a, 3, 3, 0), [0, 255, 0, 255]);
});

test('transparent index, local palette and interlaced rows', () => {
  const lct = [9, 9, 9, 8, 8, 8, 7, 7, 7, 6, 6, 6];
  // 1x8 interlaced: stored rows are 0, 4, 2, 6, 1, 3, 5, 7.
  const stored = [0, 1, 2, 3, 0, 1, 2, 3];
  const bytes = Uint8Array.from([
    ...head(1, 8, PAL4),
    ...gce(0, 5, 3), ...img(0, 0, 1, 8, stored, 0x40 | 0x80 | 1, lct),
    0x3b,
  ]);
  const a = GifRead.decodeGif(bytes);
  const rows = [0, 4, 2, 6, 1, 3, 5, 7];
  rows.forEach((y, i) => {
    const want = stored[i] === 3 ? 0 : 255;
    assert.equal(px(a, 0, 0, y)[3], want, `row ${y}`);
    if (want) assert.equal(px(a, 0, 0, y)[0], lct[stored[i] * 3]);
  });
  assert.equal(a.frames[0].delay, 50);
  // A delay of 10 ms or less plays as 100 ms, as in browsers.
  const fast = GifRead.decodeGif(Uint8Array.from([...head(1, 1, PAL4), ...gce(0, 1), ...img(0, 0, 1, 1, [1]), 0x3b]));
  assert.equal(fast.frames[0].delay, 100);
});

test('maxSide and maxPixels bound what is kept without changing the pace', () => {
  const frames = Array.from({ length: 16 }, (_, i) => frame(40, 20, () => [i * 15, 0, 0, 255], 50));
  const bytes = GifWrite.encodeGif({ width: 40, height: 20, loop: 0, frames });
  const a = GifRead.decodeGif(bytes, { maxSide: 20, maxPixels: 20 * 10 * 4 });
  assert.equal(a.width, 20);
  assert.equal(a.height, 10);
  assert.ok(a.frames.length <= 4, `${a.frames.length} frames`);
  assert.equal(a.frames.reduce((t, f) => t + f.delay, 0), 16 * 50);
});

test('animatedKind tells moving pictures from still ones by their bytes', () => {
  const two = GifWrite.encodeGif({ width: 2, height: 2, loop: 0, frames: [frame(2, 2, () => [0, 0, 0, 255]), frame(2, 2, () => [255, 0, 0, 255])] });
  const one = GifWrite.encodeGif({ width: 2, height: 2, loop: 0, frames: [frame(2, 2, () => [0, 0, 0, 255])] });
  assert.equal(GifRead.animatedKind(two), 'gif');
  assert.equal(GifRead.animatedKind(one), '');
  const riff = (vp8x, flags) => Uint8Array.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP'), ...Buffer.from(vp8x), 10, 0, 0, 0, flags, 0, 0, 0]);
  assert.equal(GifRead.animatedKind(riff('VP8X', 0x02)), 'webp');
  assert.equal(GifRead.animatedKind(riff('VP8X', 0x10)), '');
  assert.equal(GifRead.animatedKind(riff('VP8 ', 0x02)), '');
  const chunk = (type, body) => [0, 0, 0, body.length, ...Buffer.from(type), ...body, 0, 0, 0, 0];
  const png = (...chunks) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', new Array(13).fill(0)), ...chunks.flat()]);
  assert.equal(GifRead.animatedKind(png(chunk('acTL', [0, 0, 0, 3, 0, 0, 0, 0]), chunk('IDAT', [1]))), 'png');
  assert.equal(GifRead.animatedKind(png(chunk('IDAT', [1]), chunk('acTL', [0, 0, 0, 3, 0, 0, 0, 0]))), '');
  assert.equal(GifRead.animatedKind(new Uint8Array(40)), '');
  assert.equal(GifRead.decodeGif(new Uint8Array(40)), null);
});

test('damaged GIFs never throw', () => {
  const good = GifWrite.encodeGif({ width: 30, height: 30, loop: 0, frames: [frame(30, 30, (x, y) => [x * 8, y * 8, 0, 255]), frame(30, 30, () => [9, 9, 9, 255])] });
  for (const cut of [13, 20, 40, good.length - 5]) assert.doesNotThrow(() => GifRead.decodeGif(good.slice(0, cut)));
  const noisy = good.slice();
  for (let i = 40; i < noisy.length; i += 7) noisy[i] ^= 0x5a;
  assert.doesNotThrow(() => GifRead.decodeGif(noisy));
});

test('shrinkGif fits the budget, keeps the motion and its timing', async () => {
  const W = 320, H = 180;
  const frames = Array.from({ length: 24 }, (_, i) => frame(W, H, (x, y) => [(x + i * 9) & 255, (y * 3 + i * 5) & 255, (x ^ y) & 255, 255], 60));
  const anim = { width: W, height: H, loop: 0, frames };
  const full = GifWrite.encodeGif(anim).length;
  const budget = Math.floor(full / 5);
  const out = await GifWrite.shrinkGif(anim, budget, { maxSide: 2560 });
  assert.ok(out, 'it fits');
  assert.ok(out.bytes.length <= budget, `${out.bytes.length} <= ${budget}`);
  const back = GifRead.decodeGif(out.bytes);
  assert.ok(back.frames.length > 1, 'still moving');
  assert.equal(back.frames.reduce((t, f) => t + f.delay, 0), 24 * 60);
  assert.equal(Math.round((back.width / back.height) * 10), Math.round((W / H) * 10));
  // maxSide alone shrinks too.
  const capped = await GifWrite.shrinkGif(anim, full * 2, { maxSide: 160 });
  assert.equal(capped.width, 160);
  // An impossible budget says so instead of writing something broken.
  assert.equal(await GifWrite.shrinkGif(anim, 200, {}), null);
});

// --- wiring: every editor that used to flatten a moving picture now asks first.
import { readFileSync } from 'node:fs';
const src = f => readFileSync(new URL(f, import.meta.url), 'utf8');

test('the codec loads before the editors that use it', () => {
  const INDEX = src('../index.html');
  const at = f => INDEX.indexOf(`<script src="js/${f}"></script>`);
  const codec = ['gif-read.js', 'gif-write.js', 'anim-picture.js'].map(at);
  assert.ok(codec.every(i => i > 0), 'on the page');
  assert.deepEqual(codec, codec.slice().sort((a, b) => a - b), 'reader, writer, then the picker glue');
  for (const user of ['ambient-canvas-editor-form.js', 'deck.js', 'deck-editor.js']) {
    assert.ok(at(user) > codec[2], `${user} loads after anim-picture.js`);
  }
});

test('scene pictures, key pictures and Deck decorations keep moving pictures moving', () => {
  for (const f of ['../js/ambient-canvas-editor-form.js', '../js/deck.js', '../js/deck-editor.js']) {
    assert.match(src(f), /AnimPicture\.fitAnimatedPicture\(file, \{ maxChars: [A-Z_]+, maxSide: /, f);
  }
  // Tile decorations upload the file itself: an animated WebP or APNG skips the canvas.
  assert.match(src('../js/dashboard-layout.js'), /GifRead\.animatedKind\(head\)\) return file;/);
});

test('what a refused picture says exists in all 11 languages', () => {
  const I18N = src('../js/i18n.js');
  for (const k of ['picture_too_big', 'picture_frames', 'picture_kept_still', 'ace_picture_failed']) {
    assert.equal((I18N.match(new RegExp('^  ' + k + ': ', 'gm')) || []).length, 11, k);
  }
});
