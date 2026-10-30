// Animated WebP and MP4 through ffmpeg. MP4: frames are resampled here to a
// fixed 30 fps so the length is exact. WebP: ffmpeg rounds animated
// WebP timing, so it only encodes each frame and webp-mux.mjs assembles the
// animation with the exact durations.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodePng } from './png.mjs';
import { muxAnimatedWebp } from './webp-mux.mjs';

export function ffmpegPath() {
  return process.env.FFMPEG || 'ffmpeg';
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    let err = '';
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-4000);
    });
    child.on('error', (e) =>
      reject(e.code === 'ENOENT' ? new Error('ffmpeg not found: install it or set FFMPEG to its path') : e),
    );
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}:\n${err}`))));
  });
}

const MP4_FPS = 30;
const MP4_ARGS = [
  '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
  '-c:v', 'libx264', '-crf', '14', '-preset', 'slow', '-tune', 'animation',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
];

const frameName = (i, ext) => `f${String(i).padStart(4, '0')}.${ext}`;

async function withFrames(frames, work) {
  const dir = await mkdtemp(path.join(tmpdir(), 'xenon-bit-'));
  try {
    for (let i = 0; i < frames.length; i++) await writeFile(path.join(dir, frameName(i, 'png')), encodePng(frames[i]));
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Which source frame shows at each tick of a fixed frame rate. */
export function resample(durations, fps) {
  const total = durations.reduce((s, ms) => s + ms, 0);
  const ticks = Math.max(1, Math.round((total * fps) / 1000));
  const out = [];
  let k = 0;
  let end = durations[0];
  for (let t = 0; t < ticks; t++) {
    const at = (t * 1000) / fps;
    while (at >= end && k < durations.length - 1) end += durations[++k];
    out.push(k);
  }
  return out;
}

async function encodeMp4(frames, outFile) {
  const ticks = resample(frames.map((f) => f.ms), MP4_FPS);
  await withFrames(ticks.map((k) => frames[k]), (dir) =>
    run(ffmpegPath(), ['-y', '-v', 'error', '-framerate', String(MP4_FPS), '-start_number', '0', '-i', path.join(dir, 'f%04d.png'), ...MP4_ARGS, outFile]),
  );
}

async function encodeWebp(frames, outFile) {
  await withFrames(frames, async (dir) => {
    const input = path.join(dir, 'f%04d.png');
    await run(ffmpegPath(), ['-y', '-v', 'error', '-start_number', '0', '-i', input, '-c:v', 'libwebp', '-lossless', '1', '-f', 'image2', '-start_number', '0', path.join(dir, 'f%04d.webp')]);
    const stills = await Promise.all(frames.map((_, i) => readFile(path.join(dir, frameName(i, 'webp')))));
    const { width, height } = frames[0];
    await writeFile(outFile, muxAnimatedWebp(stills, frames.map((f) => f.ms), width, height));
  });
}

/**
 * @param {Array<{ width: number, height: number, data: Uint8Array, ms: number }>} frames
 * @param {'webp'|'mp4'} format
 * @param {string} outFile
 */
export async function encodeVideo(frames, format, outFile) {
  if (format === 'mp4') return encodeMp4(frames, outFile);
  if (format === 'webp') return encodeWebp(frames, outFile);
  throw new Error(`Unknown video format: ${format}`);
}
