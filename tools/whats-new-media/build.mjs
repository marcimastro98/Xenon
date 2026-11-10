// The moving pictures of the What's New sheets, one command each:
//   node tools/whats-new-media/build.mjs [look] [widgets] [map] [maker] [supporters]
// With no name it builds all five. Each writes <name>.mp4 and a <name>.webp
// poster to server/assets/whatsnew/. `maker` also writes the Maker's pictures in
// docs/images/home: the home page's clip and poster, the Create page's and the
// Store sheet's stills. It needs the Maker's dev server
// (`npm run dev -- --port 5183 --strictPort` in ../xenon-maker), or WN_MAKER_URL.
// `map` needs a side copy of the server (.claude/scripts/side-server.mjs), or WN_MENU_URL.
// `look` and `widgets` shoot the demo: run tools/build-demo.mjs first.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { shot } from '../site-shots/desktop.mjs';
import { startSite } from '../site-shots/serve.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';
import { lookArgs, shootLooks } from './look.mjs';
import { CURSOR, STILLS, concatList, encodeArgs, recordMaker, shootStill, stillArgs } from './maker.mjs';
import { recordMap } from './map.mjs';
import { mosaicArgs } from './supporters.mjs';
import { widgetsArgs } from './widgets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUT_DIR = path.join(ROOT, 'server', 'assets', 'whatsnew');
const HOME_DIR = path.join(ROOT, 'docs', 'images', 'home');
const MAKER_URL = process.env.WN_MAKER_URL || 'http://localhost:5183/maker/';
const MENU_URL = process.env.WN_MENU_URL || 'http://127.0.0.1:3050/';
const FFMPEG_TIMEOUT_MS = 120000;
export const MAX_CLIP_BYTES = 1.5 * 1024 * 1024;

/** The second of each clip the poster is taken from: everything on screen. */
export const POSTER_AT = { look: 4.5, widgets: 4.4, map: 4, maker: 9.5, supporters: 3 };

export function posterArgs(video, out, at) {
  return ['-y', '-v', 'error', '-ss', String(at), '-i', video, '-frames:v', '1',
    '-c:v', 'libwebp', '-quality', '82', out];
}

/** The home page's poster: the video's own shape, smaller, as it waits to play. */
export function homePosterArgs(video, out, at) {
  return ['-y', '-v', 'error', '-ss', String(at), '-i', video, '-frames:v', '1',
    '-vf', 'scale=640:-1:flags=lanczos', '-q:v', '3', out];
}

function ffmpeg(args) {
  const run = spawnSync('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'], timeout: FFMPEG_TIMEOUT_MS });
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.error?.message || run.status}`);
}

async function withBrowser(work) {
  const browser = await loadPlaywright().chromium.launch();
  try {
    return await work(browser);
  } finally {
    await browser.close();
  }
}

async function buildWidgets(out, tmp) {
  const wall = path.join(tmp, 'wall.png');
  const layer = path.join(tmp, 'layer.png');
  const site = await startSite(0);
  try {
    await withBrowser(async (browser) => {
      const base = `http://127.0.0.1:${site.port}/`;
      await shot(browser, base, 'wallpaper', wall);
      await shot(browser, base, 'layer', layer);
    });
  } finally {
    await site.stop();
  }
  ffmpeg(widgetsArgs(wall, layer, out));
}

async function buildLook(out, tmp) {
  const before = path.join(tmp, 'before.png');
  const after = path.join(tmp, 'after.png');
  const site = await startSite(0);
  try {
    await withBrowser((browser) => shootLooks(browser, `http://127.0.0.1:${site.port}/`, before, after));
  } finally {
    await site.stop();
  }
  ffmpeg(lookArgs(before, after, out));
}

async function buildMaker(out, tmp) {
  const frames = await withBrowser((browser) => recordMaker(browser, MAKER_URL, tmp));
  const list = path.join(tmp, 'frames.txt');
  writeFileSync(list, concatList(frames));
  ffmpeg(encodeArgs(list, out));
}

async function publishMaker(video, tmp) {
  copyFileSync(video, path.join(HOME_DIR, 'maker.mp4'));
  ffmpeg(homePosterArgs(video, path.join(HOME_DIR, 'maker.jpg'), POSTER_AT.maker));
  await withBrowser(async (browser) => {
    for (const still of STILLS) {
      const png = path.join(tmp, `${still.file}.png`);
      await shootStill(browser, MAKER_URL, still, png);
      ffmpeg(stillArgs(png, path.join(HOME_DIR, still.file), still));
    }
  });
}

async function buildMap(out, tmp) {
  const frames = await withBrowser((browser) => recordMap(browser, MENU_URL, tmp, CURSOR));
  const list = path.join(tmp, 'frames.txt');
  writeFileSync(list, concatList(frames));
  ffmpeg(encodeArgs(list, out));
}

async function buildSupporters(out) {
  ffmpeg(mosaicArgs(ROOT, out));
}

const BUILDERS = { look: buildLook, widgets: buildWidgets, map: buildMap, maker: buildMaker, supporters: buildSupporters };
const AFTER = { maker: publishMaker };

async function build(name) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), `xenon-wn-${name}-`));
  const video = path.join(OUT_DIR, `${name}.mp4`);
  try {
    await BUILDERS[name](video, tmp);
    ffmpeg(posterArgs(video, path.join(OUT_DIR, `${name}.webp`), POSTER_AT[name]));
    await AFTER[name]?.(video, tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const { size } = statSync(video);
  if (size > MAX_CLIP_BYTES) throw new Error(`${name}.mp4 is ${size} bytes, over the limit`);
  console.log(`${name}: ${Math.round(size / 1024)} KB`);
}

async function main(names) {
  const unknown = names.find((name) => !BUILDERS[name]);
  if (unknown) throw new Error(`unknown clip: ${unknown}`);
  mkdirSync(OUT_DIR, { recursive: true });
  for (const name of names.length ? names : Object.keys(BUILDERS)) await build(name);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
