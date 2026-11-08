// The Lyrics clip of the widgets page: the real tile on the wallpaper, on a made-up song
// with its Italian lines written here. Frames come from the browser's screencast, not its
// video recorder, which blurs text. Writes lyrics-widget.mp4 and its .webp poster.
// Run: node tools/site-shots/lyrics-clip.mjs [--out dir]   (default docs/images/home)

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initScript } from './scenes.mjs';
import { DOCS_DIR, startSite } from './serve.mjs';
import { answerRequest, soloLayout } from './widgets.mjs';
import { dataUri, landscape } from '../tile-previews/art.mjs';
import { fixtureScript } from '../tile-previews/fixtures.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';
import { posterArgs } from '../whats-new-media/build.mjs';
import { concatList, encodeArgs } from '../whats-new-media/maker.mjs';

export const CLIP = { width: 1280, height: 800, fps: 30 };
const RECORD_MS = 18000;
const POSTER_AT_S = 9;
const FIRST_LINE_MS = 4500;
const LINE_MS = 3800;
const LINE_READY_MS = 15000;
const FFMPEG_TIMEOUT_MS = 120000;
// The side rails come with the hidden top bar: in a clip of one tile they only add noise.
const CLIP_CSS = '.demo-na,.xtoast-stack,.edge-rail{display:none!important}';

const SONG = { title: 'Kettle Warm Till Nine', artist: 'Ottavia North', album: 'Porch Light', duration: 214 };
const VERSES = [
  ['I left the porch light on for you', 'Ho lasciato accesa la luce del portico per te'],
  ['counting cars along the avenue', 'contando le auto lungo il viale'],
  ['every window hums a different tune', 'ogni finestra canticchia un motivo diverso'],
  ['and mine is waiting for the moon', 'e la mia sta aspettando la luna'],
  ['so take the long way, take your time', 'allora fai il giro lungo, prenditi il tuo tempo'],
  ["I'll keep the kettle warm till nine", 'terrò il bollitore caldo fino alle nove'],
  ['paper planes across the sky', 'aeroplani di carta attraverso il cielo'],
  ['spelling out your name as they go by', 'scrivono il tuo nome mentre passano'],
];

export function lyricsFixture() {
  const thumbnail = dataUri(landscape({ seed: 12, top: '#a82a5e', bottom: '#ff9a3f', sun: '#ffe08a', hills: ['#a8324f', '#6a2a6f', '#2b2a7a'], w: 320, h: 320 }));
  const lines = VERSES.map(([text], i) => ({ t: FIRST_LINE_MS + i * LINE_MS, text }));
  return {
    settings: { lyricsTranslate: true },
    answers: {
      '/api/features/lyrics': { ok: true, unlocked: true },
      '/api/lyrics': { ok: true, state: 'synced', key: 'clip-kettle', title: SONG.title, source: 'LRCLIB', lines },
      '/api/lyrics/translate': { ok: true, tr: VERSES.map(([, line]) => line), read: [] },
    },
    demo: `(D) => { D.playlist = [${JSON.stringify({ ...SONG, thumbnail })}]; }`,
  };
}

async function recordFrames(page, ctx, dir) {
  const frames = [];
  const cdp = await ctx.newCDPSession(page);
  cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
    const file = path.join(dir, `f${String(frames.length).padStart(5, '0')}.jpg`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, at: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
  await page.waitForTimeout(RECORD_MS);
  await cdp.send('Page.stopScreencast');
  return frames;
}

async function shootClip(browser, base, dir) {
  const ctx = await browser.newContext({ viewport: { width: CLIP.width, height: CLIP.height }, locale: 'en-US', timezoneId: 'Europe/Rome' });
  try {
    const fixture = lyricsFixture();
    await ctx.route('**/*', (r) => answerRequest(r, new URL(base).origin, fixture));
    await ctx.addInitScript({ content: initScript({ layout: soloLayout('lyrics', fixture) }) });
    await ctx.addInitScript({ content: fixtureScript(fixture) });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
    await page.goto(`${base}demo/`, { waitUntil: 'load' });
    await page.addStyleTag({ content: CLIP_CSS });
    await page.locator('.lyrics-panel .lyv-line').first().waitFor({ timeout: LINE_READY_MS });
    return { frames: await recordFrames(page, ctx, dir), errors };
  } finally {
    await ctx.close();
  }
}

function ffmpeg(args) {
  const run = spawnSync('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'], timeout: FFMPEG_TIMEOUT_MS });
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.error?.message || run.status}`);
}

async function main() {
  const at = process.argv.indexOf('--out');
  const outDir = path.resolve(at >= 0 ? process.argv[at + 1] : path.join(DOCS_DIR, 'images', 'home'));
  if (!existsSync(path.join(DOCS_DIR, 'demo', 'index.html'))) throw new Error('docs/demo is missing: run node tools/build-demo.mjs first');
  mkdirSync(outDir, { recursive: true });
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'xenon-lyrics-clip-'));
  const site = await startSite(0);
  const browser = await loadPlaywright().chromium.launch();
  try {
    const { frames, errors } = await shootClip(browser, `http://127.0.0.1:${site.port}/`, tmp);
    const list = path.join(tmp, 'frames.txt');
    writeFileSync(list, concatList(frames));
    const video = path.join(outDir, 'lyrics-widget.mp4');
    ffmpeg(encodeArgs(list, video, CLIP));
    ffmpeg(posterArgs(video, path.join(outDir, 'lyrics-widget.webp'), POSTER_AT_S));
    console.log(JSON.stringify({ frames: frames.length, errors }));
  } finally {
    await browser.close();
    await site.stop();
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
