import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { parseColor, rasterFrame, bit } from '../../tools/bit-export/raster.mjs';
import { crc32, encodePng, joinHorizontal } from '../../tools/bit-export/png.mjs';
import { encodeGif, lzw } from '../../tools/bit-export/gif.mjs';
import { exportClip, parseCli } from '../../tools/bit-export/cli.mjs';
import { resample } from '../../tools/bit-export/video.mjs';
import { imageChunks } from '../../tools/bit-export/webp-mux.mjs';

const hasFfmpeg = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-version'], { windowsHide: true }).status === 0;
const px = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
const IDLE = bit.rgb('idle').split(',').map(Number);

// Standard GIF LZW decoder, written apart from the encoder to check it.
function unlzw(bytes, min) {
  const clear = 1 << min;
  const eoi = clear + 1;
  let size = min + 1;
  let dict;
  let next;
  const reset = () => {
    dict = Array.from({ length: clear }, (_, i) => [i]);
    next = eoi + 1;
    size = min + 1;
  };
  reset();
  let pos = 0;
  const read = () => {
    let code = 0;
    for (let i = 0; i < size; i++, pos++) code |= ((bytes[pos >> 3] >> (pos & 7)) & 1) << i;
    return code;
  };
  const out = [];
  let prev = null;
  for (;;) {
    const code = read();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry;
    if (dict[code]) entry = dict[code];
    else if (code === next && prev) entry = prev.concat(prev[0]);
    else throw new Error(`bad code ${code}`);
    out.push(...entry);
    if (prev) {
      dict[next++] = prev.concat(entry[0]);
      if (next === 1 << size && size < 12) size++;
    }
    prev = entry;
  }
  return out;
}

// Walks a GIF's blocks: frame count, delays, and each frame's pixel indices.
function readGif(buf) {
  assert.equal(buf.subarray(0, 6).toString('ascii'), 'GIF89a');
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  let p = 13 + (buf[10] & 0x80 ? 3 << ((buf[10] & 7) + 1) : 0);
  const frames = [];
  let delay = 0;
  const blocks = () => {
    const parts = [];
    while (buf[p]) {
      parts.push(buf.subarray(p + 1, p + 1 + buf[p]));
      p += buf[p] + 1;
    }
    p++;
    return Buffer.concat(parts);
  };
  while (buf[p] !== 0x3b) {
    if (buf[p] === 0x21) {
      if (buf[p + 1] === 0xf9) delay = buf.readUInt16LE(p + 4);
      p += 2;
      blocks();
    } else if (buf[p] === 0x2c) {
      p += 10;
      const min = buf[p++];
      frames.push({ delay, indices: unlzw(blocks(), min) });
    } else throw new Error(`bad block ${buf[p]} at ${p}`);
  }
  return { width, height, frames };
}

test('raster: body, face and background land on the right pixels', () => {
  const img = rasterFrame('idle', 0, { scale: 1 });
  assert.equal(img.width, 18);
  assert.equal(img.height, 17);
  // stage starts at x -3, y -5: body cell (2,3) is pixel (5,8), left eye (4,4) is (7,9)
  assert.deepEqual(px(img, 5, 8), [...IDLE, 255]);
  assert.deepEqual(px(img, 7, 9), [13, 17, 23, 255]);
  assert.equal(px(img, 0, 0)[3], 0);
  const dark = rasterFrame('idle', 0, { scale: 1, background: '#0a0c0d' });
  assert.deepEqual(px(dark, 0, 0), [10, 12, 13, 255]);
});

test('raster: scale multiplies cells and tint recolors the body', () => {
  const img = rasterFrame('idle', 0, { scale: 4, tint: 'sleep' });
  assert.equal(img.width, 72);
  assert.deepEqual(px(img, 5 * 4 + 2, 8 * 4 + 2), [138, 180, 248, 255]);
});

test('raster: the floor hides Bit when it ducks below it', () => {
  const peek = bit.clip('peek');
  const deep = peek.frames.findIndex((f) => f.dy === 10);
  const img = rasterFrame(peek, deep, { scale: 1 });
  const floorRow = 11 + 5;
  for (let y = floorRow; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) assert.equal(px(img, x, y)[3], 0, `pixel ${x},${y}`);
  }
});

test('raster: a mirrored frame is the mirror image', () => {
  // armL is cells (1,4),(0,3); mirrored around x 6 it lands on (10,4),(11,3)
  const img = rasterFrame({ id: 't', kind: 'react', frames: [{ ms: 100, sx: -1, ex: ['armL'] }] }, 0, { scale: 1 });
  assert.deepEqual(px(img, 13, 9), [...IDLE, 255]);
  assert.deepEqual(px(img, 14, 8), [...IDLE, 255]);
  assert.equal(px(img, 4, 9)[3], 0);
  assert.equal(px(img, 3, 8)[3], 0);
});

test('resample holds each frame for its own time at a fixed rate', () => {
  assert.deepEqual(resample([100, 50, 150], 20), [0, 0, 1, 2, 2, 2]);
  assert.equal(resample([150, 150, 500], 30).length, 24);
  assert.deepEqual(resample([10], 30), [0]);
});

test('webp mux refuses files that are not WebP', () => {
  assert.throws(() => imageChunks(Buffer.from('not a webp at all')), /Not a WebP/);
});

test('parseColor reads hex and rgb, rejects junk', () => {
  assert.deepEqual(parseColor('#ff8000'), [255, 128, 0]);
  assert.deepEqual(parseColor('rgb(1, 2, 3)'), [1, 2, 3]);
  assert.throws(() => parseColor('red'));
});

test('png: valid signature, chunks and pixels that inflate back', () => {
  const img = rasterFrame('wave', 0, { scale: 2 });
  const png = encodePng(img);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), img.width);
  assert.equal(png.readUInt32BE(20), img.height);
  assert.equal(png.readUInt32BE(png.length - 4), 0xae426082); // IEND crc
  const idatLen = png.readUInt32BE(33);
  const raw = inflateSync(png.subarray(41, 41 + idatLen));
  const stride = img.width * 4;
  for (let y = 0; y < img.height; y++) {
    assert.equal(raw[y * (stride + 1)], 0);
    assert.deepEqual(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), Buffer.from(img.data.subarray(y * stride, (y + 1) * stride)));
  }
  assert.equal(crc32(Buffer.from('IEND')), 0xae426082);
});

test('sprite sheet puts frames side by side', () => {
  const a = rasterFrame('idle', 0, { scale: 1 });
  const b = rasterFrame('idle', 0, { scale: 1, tint: 'think' });
  const sheet = joinHorizontal([a, b]);
  assert.equal(sheet.width, 36);
  assert.deepEqual(px(sheet, 5, 8), px(a, 5, 8));
  assert.deepEqual(px(sheet, 18 + 5, 8), px(b, 5, 8));
});

test('lzw round-trips, including past the 4096-code reset', () => {
  let seed = 9;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const min of [2, 3, 5, 8]) {
    const data = Array.from({ length: 30000 }, () => Math.floor(rand() * (1 << min)));
    assert.deepEqual(unlzw(lzw(data, min), min), data, `min ${min}`);
  }
  const flat = new Array(5000).fill(1);
  assert.deepEqual(unlzw(lzw(flat, 2), 2), flat);
});

test('gif: every frame, with its delay, decodes back to the right colors', () => {
  const clip = bit.clip('celebrate');
  const frames = clip.frames.map((f, i) => ({ ...rasterFrame(clip, i, { scale: 2, background: '#0a0c0d' }), ms: f.ms }));
  const gif = readGif(encodeGif(frames));
  assert.equal(gif.width, frames[0].width);
  assert.equal(gif.frames.length, clip.frames.length);
  assert.deepEqual(gif.frames.map((f) => f.delay), clip.frames.map((f) => Math.round(f.ms / 10)));
  for (const f of gif.frames) assert.equal(f.indices.length, gif.width * gif.height);
});

test('gif: transparent background keeps index 0 for empty pixels', () => {
  const img = { ...rasterFrame('idle', 0, { scale: 1 }), ms: 100 };
  const gif = readGif(encodeGif([img], { transparent: true }));
  const idx = gif.frames[0].indices;
  assert.equal(idx[0], 0);
  assert.notEqual(idx[8 * 18 + 5], 0);
});

test('parseCli validates every option', () => {
  const o = parseCli(['hop', '--format', 'gif,png', '--scale', '8', '--bg', '#000000', '--tint', 'think']);
  assert.deepEqual(o.ids, ['hop']);
  assert.deepEqual(o.formats, ['gif', 'png']);
  assert.equal(o.scale, 8);
  assert.equal(parseCli([]).ids.length, bit.clips.length);
  assert.ok(parseCli(['--kind', 'react']).ids.every((id) => bit.clip(id).kind === 'react'));
  assert.throws(() => parseCli(['nope']), /Unknown clip/);
  assert.throws(() => parseCli(['--format', 'bmp']), /Unknown format/);
  assert.throws(() => parseCli(['--scale', '0']), /scale/);
  assert.throws(() => parseCli(['--bg', 'blue']), /color/);
  assert.throws(() => parseCli(['--tint', 'purple']), /tint/);
  assert.equal(parseCli(['--tint', '1,2,3']).tint, '1,2,3');
});

test('exportClip writes svg, png, sheet and gif files that open', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bit-export-test-'));
  try {
    const files = await exportClip('nod', { formats: ['svg', 'png', 'sheet', 'gif'], scale: 4, outDir: dir });
    assert.equal(files.length, 5);
    assert.match(await readFile(path.join(dir, 'nod.svg'), 'utf8'), /^<svg /);
    const meta = JSON.parse(await readFile(path.join(dir, 'nod.sheet.json'), 'utf8'));
    assert.equal(meta.frames.length, bit.clip('nod').frames.length);
    const sheet = await readFile(path.join(dir, 'nod.sheet.png'));
    assert.equal(sheet.readUInt32BE(16), meta.frameWidth * meta.frames.length);
    assert.equal(readGif(await readFile(path.join(dir, 'nod.gif'))).frames.length, meta.frames.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('exportClip: animated webp and mp4 keep frames and timing', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bit-export-test-'));
  try {
    const clip = bit.clip('celebrate');
    await exportClip('celebrate', { formats: ['webp', 'mp4'], scale: 4, loops: 2, outDir: dir });
    const webp = await readFile(path.join(dir, 'celebrate.webp'));
    assert.equal(webp.subarray(0, 4).toString('ascii'), 'RIFF');
    let anmf = 0;
    let ms = 0;
    for (let p = 12; p < webp.length; ) {
      const id = webp.subarray(p, p + 4).toString('ascii');
      const len = webp.readUInt32LE(p + 4);
      if (id === 'ANMF') {
        anmf++;
        ms += webp.readUIntLE(p + 8 + 12, 3);
      }
      p += 8 + len + (len & 1);
    }
    assert.equal(anmf, 2 * clip.frames.length);
    assert.equal(ms, 2 * bit.duration(clip));
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(dir, 'celebrate.mp4')], { encoding: 'utf8', windowsHide: true });
    if (probe.status === 0) assert.ok(Math.abs(Number(probe.stdout) * 1000 - 2 * bit.duration(clip)) <= 40, `mp4 ${probe.stdout}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
