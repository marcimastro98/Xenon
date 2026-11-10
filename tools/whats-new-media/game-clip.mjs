// A real game with Xenon's performance readings over it, for the game sheet of the 5.0
// page (docs/5.html), in three steps:
//   node tools/whats-new-media/game-clip.mjs record [--monitor 0] [--seconds 14] [--out file]
//   node tools/whats-new-media/game-clip.mjs still <recording> [--at 4] [--out file.png]
//   node tools/whats-new-media/game-clip.mjs build <recording> --keep x,y,w,h [--frame x,y,w,h] [--from 1] [--name game]
// record  grabs one monitor with Desktop Duplication while the game runs (borderless or
//         windowed: an exclusive full-screen game may come out black). It writes to the
//         system's temp folder, never into the repo: a raw recording can show anything
//         that was on that screen.
// still   one frame of the recording, to find the readings and pass their box to build.
// build   blurs everything but that box, so only Xenon reaches the site and the game's
//         own pictures (clubs, players, names on screen, a friend's name in a widget) never
//         do, then loops it with a short crossfade into docs/images/v5/<name>.mp4 and a
//         poster beside it. --frame cuts a 16:9 part of the screen first: readings drawn
//         for a 4K screen are too small to read once the whole screen is page-sized.
// Look at the poster and a few frames of the built clip before using it on the page.
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_CLIP_BYTES, posterArgs } from './build.mjs';
import { SITE_DIR, loopArgs } from './site.mjs';

export const CLIP = { width: 1280, height: 720, fps: 30, blur: 30, feather: 14, posterAt: 1.5 };
const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000;

// Desktop Duplication hands over GPU frames: they come back to memory before encoding,
// fast and nearly lossless, since build encodes again.
export function recordArgs(monitor, seconds, out) {
  if (!Number.isInteger(monitor) || monitor < 0) throw new Error(`bad monitor: ${monitor}`);
  if (!(seconds > 0)) throw new Error(`bad length: ${seconds}`);
  return ['-y', '-v', 'error', '-f', 'lavfi', '-i', `ddagrab=output_idx=${monitor}:framerate=${CLIP.fps}:draw_mouse=0`,
    '-t', String(seconds), '-vf', 'hwdownload,format=bgra,format=yuv420p',
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '14', out];
}

export function frameArgs(recording, at, out) {
  return ['-y', '-v', 'error', '-ss', String(at), '-i', recording, '-frames:v', '1', out];
}

// "x,y,w,h" in the recording's own pixels, whole and positive.
export function parseKeep(text) {
  const parts = String(text || '').split(',').map(Number);
  if (parts.length !== 4 || !parts.every((n) => Number.isInteger(n) && n >= 0) || !parts[2] || !parts[3]) {
    throw new Error(`--keep takes x,y,w,h in pixels, got "${text}"`);
  }
  const [x, y, width, height] = parts;
  return { x, y, width, height };
}

// A part of the screen to show, as the page's video is: 16:9.
export function parseFrame(text) {
  const frame = parseKeep(text);
  if (frame.width * 9 !== frame.height * 16) throw new Error(`--frame must be 16:9, got ${frame.width}x${frame.height}`);
  return frame;
}

// The whole screen blurred, the readings laid back sharp on top with soft edges (an
// over-game reading has no panel, and a hard box of sharp game read as a sticker),
// then the page's size
// (after cutting `frame` out of it, when there is one).
export function blurArgs(recording, out, keep, from = 0, frame = null) {
  const { x, y, width, height } = keep;
  const cut = frame ? `crop=${frame.width}:${frame.height}:${frame.x}:${frame.y},` : '';
  return ['-y', '-v', 'error', '-ss', String(from), '-i', recording, '-filter_complex',
    `[0:v]split[a][b];[a]gblur=sigma=${CLIP.blur}[bg];[b]crop=${width}:${height}:${x}:${y},format=yuva444p,` +
    `geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='255*min(1,min(min(X,W-1-X),min(Y,H-1-Y))/${CLIP.feather})'[k];` +
    `[bg][k]overlay=${x}:${y},${cut}fps=${CLIP.fps},scale=${CLIP.width}:${CLIP.height}:flags=lanczos,format=yuv420p[v]`,
    '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', out];
}

export function parseArgs(argv) {
  const [step, ...rest] = argv;
  if (!['record', 'still', 'build'].includes(step)) throw new Error(`unknown step: ${step || '(none)'}; use record, still or build`);
  const opts = { step, input: null };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) { opts.input = arg; continue; }
    const value = rest[i + 1];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    opts[arg.slice(2)] = value;
    i += 1;
  }
  if (step !== 'record' && !opts.input) throw new Error(`${step} needs the recording`);
  if (step === 'build' && !opts.keep) throw new Error('build needs --keep x,y,w,h');
  if (opts.name && !/^[a-z][a-z0-9-]*$/.test(opts.name)) throw new Error(`bad name: ${opts.name}`);
  return opts;
}

function ffmpeg(args) {
  const run = spawnSync('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'], timeout: FFMPEG_TIMEOUT_MS });
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.error?.message || run.status}`);
}

function seconds(file) {
  const run = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Number(run.stdout.trim());
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const temp = path.join(os.tmpdir(), 'xenon-game-clip');
  mkdirSync(temp, { recursive: true });
  if (opts.step === 'record') {
    const out = opts.out || path.join(temp, 'recording.mp4');
    ffmpeg(recordArgs(Number(opts.monitor || 0), Number(opts.seconds || 14), out));
    console.log(`recorded: ${out}`);
    return;
  }
  if (opts.step === 'still') {
    const out = opts.out || path.join(temp, 'still.png');
    ffmpeg(frameArgs(opts.input, Number(opts.at || 4), out));
    console.log(`still: ${out}`);
    return;
  }
  const name = opts.name || 'game';
  const blurred = path.join(temp, `${name}-blurred.mp4`);
  const video = path.join(SITE_DIR, `${name}.mp4`);
  const frame = opts.frame ? parseFrame(opts.frame) : null;
  ffmpeg(blurArgs(opts.input, blurred, parseKeep(opts.keep), Number(opts.from || 0), frame));
  ffmpeg(loopArgs(blurred, video, seconds(blurred)));
  ffmpeg(posterArgs(video, path.join(SITE_DIR, `${name}.webp`), CLIP.posterAt));
  const bytes = statSync(video).size;
  if (bytes > MAX_CLIP_BYTES) throw new Error(`${name}.mp4 is ${bytes} bytes, over ${MAX_CLIP_BYTES}: record fewer seconds`);
  console.log(`built: ${video} (${bytes} bytes)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
