// The pictures of the 5.0 page (docs/5.html), in docs/images/v5, one command each:
//   node tools/whats-new-media/site.mjs [copy] [edge] [bit]
// With no name it runs all three.
// copy  the What's New clips the page shows too (widgets, map, maker, supporters), copied
//       from server/assets/whatsnew so the site and the app show the same thing. Build them
//       first with build.mjs.
// edge  the first picture: the demo's Edge scene (2560 x 720, Liquid Glass) running for a
//       few seconds, from the browser's screencast, looped with a short crossfade so the
//       jump back to the start never shows. Needs docs/demo (tools/build-demo.mjs).
// bit   the panel of the What's New "bit" sheet, drawn by server/js/whats-new-scenes.js in
//       English, as a still.
// Headless, on local copies (the site's and the dashboard's): never the user's Xenon server.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from '../app-shots/serve.mjs';
import { SCENES } from '../site-shots/scenes.mjs';
import { startSite } from '../site-shots/serve.mjs';
import { withScene } from '../site-shots/shoot.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';
import { MAX_CLIP_BYTES, OUT_DIR as APP_DIR, posterArgs } from './build.mjs';
import { concatList } from './maker.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SITE_DIR = path.join(ROOT, 'docs', 'images', 'v5');
export const STEPS = ['copy', 'edge', 'bit'];
export const SHARED = ['widgets', 'map', 'maker', 'supporters'];
export const EDGE = { width: 1920, height: 540, fps: 30, recordMs: 9500, settleMs: 5000, fade: 0.8, posterAt: 1.5 };
// The What's New is drawn in units of one pixel of a 1600 x 900 screen; 1.25 gives the
// panel the size of the sheets' clips (960 px wide).
export const BIT_STAGE = { width: 1600, height: 900, scale: 1.25 };
// The panel's ink edge, on its top and left side where it meets the sheet.
const PANEL_EDGE = 4;
const FFMPEG_TIMEOUT_MS = 180000;

// The demo's stand-in video player is a picture that never answers the tile, so after
// eight seconds the tile gives up and says the video cannot play: a still never lasts
// that long, a clip does. Here the stand-in answers as the real embed does, playing,
// and its clock runs. Init scripts run in every frame; this one acts only in the player's.
const PLAYER_ANSWERS = `(() => {
  if (!/(^|\\.)youtube(-nocookie)?\\.com$/.test(location.hostname)) return;
  let started = 0;
  addEventListener('message', (e) => {
    let d = null;
    try { d = JSON.parse(e.data); } catch { return; }
    if (!d || d.event !== 'listening' || started) return;
    started = performance.now();
    const say = (event) => parent.postMessage(JSON.stringify({ event, id: d.id, channel: 'widget',
      info: { playerState: 1, duration: 2710, muted: true, currentTime: 754 + (performance.now() - started) / 1000 } }), '*');
    say('initialDelivery');
    setInterval(() => say('infoDelivery'), 250);
  });
})();`;
const HIDE_DEMO = '#demo-badge,#demo-convert,.demo-na,.xtoast-stack{display:none!important}';

// One sheet of the What's New with nothing on it, for a scene to be drawn into.
// The words come as every page of the app gets them (/layer-i18n.js, English
// always in it): js/i18n.js alone has the functions and no words.
export const SCENE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="/components/WhatsNew/WhatsNew.css">
<style>html, body { margin: 0; }</style></head>
<body><div class="wn-stage"><section class="wn-sheet wn-c-green"></section></div>
<script>let lang = 'en';</script>
<script src="/layer-i18n.js"></script>
<script src="/js/whats-new-scenes.js"></script></body></html>`;

export function pickSteps(args) {
  const names = args.filter((a) => !a.startsWith('--'));
  const bad = names.filter((n) => !STEPS.includes(n));
  if (bad.length) throw new Error(`unknown step: ${bad.join(', ')} (known: ${STEPS.join(', ')})`);
  return names.length ? STEPS.filter((s) => names.includes(s)) : STEPS.slice();
}

export function copyPlan(from = APP_DIR, to = SITE_DIR) {
  return SHARED.flatMap((name) => ['mp4', 'webp'].map((ext) => ({
    from: path.join(from, `${name}.${ext}`), to: path.join(to, `${name}.${ext}`),
  })));
}

export function rawArgs(list, out, clip = EDGE) {
  return ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', `fps=${clip.fps},scale=${clip.width}:${clip.height}:flags=lanczos,format=yuv420p`,
    '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', out];
}

// A seamless loop: the first `fade` seconds are cut, and the end fades into them, so the
// last frame leads into the first.
export function loopArgs(raw, out, seconds, fade = EDGE.fade) {
  if (!(seconds > 2 * fade)) throw new Error(`a ${seconds} s recording is too short for a ${fade} s crossfade`);
  return ['-y', '-v', 'error', '-i', raw, '-filter_complex',
    `[0:v]split[a][b];[a]trim=start=${fade}:end=${seconds},setpts=PTS-STARTPTS[main];` +
    `[b]trim=start=0:end=${fade},setpts=PTS-STARTPTS[head];` +
    `[main][head]xfade=transition=fade:duration=${fade}:offset=${(seconds - 2 * fade).toFixed(2)},format=yuv420p[v]`,
    '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '25', '-movflags', '+faststart', out];
}

// The panel inside its ink edge (which belongs to the sheet around it), from the
// conversation down, with the panel's own padding above it: the room the app keeps
// for a longer chat would read as empty on the page.
export function chatClip(panel, chatTop, pad, edge = PANEL_EDGE) {
  const top = Math.max(panel.y + edge, chatTop - pad);
  return { x: panel.x + edge, y: top, width: panel.width - edge, height: panel.y + panel.height - top };
}

export function stillArgs(png, out) {
  return ['-y', '-v', 'error', '-i', png, '-c:v', 'libwebp', '-quality', '86', out];
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

function copyShared() {
  const plan = copyPlan();
  const missing = plan.filter((p) => !existsSync(p.from)).map((p) => path.basename(p.from));
  if (missing.length) throw new Error(`missing in server/assets/whatsnew, build them first (build.mjs): ${missing.join(', ')}`);
  for (const p of plan) copyFileSync(p.from, p.to);
  return { copied: plan.length };
}

async function screencast(page, dir, ms) {
  const frames = [];
  const cdp = await page.context().newCDPSession(page);
  cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
    const file = path.join(dir, `f${String(frames.length).padStart(5, '0')}.jpg`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, at: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 94, everyNthFrame: 1 });
  await page.waitForTimeout(ms);
  await cdp.send('Page.stopScreencast');
  return frames;
}

async function buildEdge(tmp) {
  // At 1x the frames are already the Edge's own 2560 x 720.
  const scene = { ...SCENES.edge, viewport: { ...SCENES.edge.viewport, scale: 1 } };
  const site = await startSite(0);
  let shot;
  try {
    shot = await withBrowser((browser) => withScene(browser, `http://127.0.0.1:${site.port}/`, scene, async (page, errors) => {
      await page.addStyleTag({ content: HIDE_DEMO });
      // Long enough for the video's controls to hide once it plays, so the loop is steady.
      await page.waitForTimeout(EDGE.settleMs);
      return { frames: await screencast(page, tmp, EDGE.recordMs), errors };
    }, [PLAYER_ANSWERS]));
  } finally {
    await site.stop();
  }
  const { frames, errors } = shot;
  if (frames.length < 20) throw new Error(`only ${frames.length} frames recorded`);
  const list = path.join(tmp, 'frames.txt');
  writeFileSync(list, concatList(frames, 0.1));
  const raw = path.join(tmp, 'raw.mp4');
  ffmpeg(rawArgs(list, raw));
  const seconds = Math.floor((frames[frames.length - 1].at - frames[0].at) * 10) / 10;
  const video = path.join(SITE_DIR, 'edge.mp4');
  ffmpeg(loopArgs(raw, video, seconds));
  ffmpeg(posterArgs(video, path.join(SITE_DIR, 'edge.webp'), EDGE.posterAt));
  const bytes = statSync(video).size;
  if (bytes > MAX_CLIP_BYTES) throw new Error(`edge.mp4 is ${bytes} bytes, over the ${MAX_CLIP_BYTES} cap`);
  return { frames: frames.length, seconds, bytes, errors };
}

async function buildBit(tmp) {
  const app = await startApp(0);
  try {
    return await withBrowser(async (browser) => {
      const { width, height, scale } = BIT_STAGE;
      const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, locale: 'en-US', reducedMotion: 'reduce' });
      try {
        const base = `http://127.0.0.1:${app.port}/`;
        await ctx.route(`${base}__wn-scene.html`, (r) => r.fulfill({ contentType: 'text/html', body: SCENE_PAGE }));
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
        await page.goto(`${base}__wn-scene.html`, { waitUntil: 'load' });
        await page.evaluate(() => {
          document.querySelector('.wn-sheet').append(window.XenonWhatsNewScenes.bit(window.t));
          return document.fonts.ready;
        });
        const where = await page.evaluate(() => {
          const panel = document.querySelector('.wn-panel-bit');
          const first = panel && panel.querySelector('.wn-chat > *');
          if (!first) return null;
          const r = panel.getBoundingClientRect();
          return { panel: { x: r.x, y: r.y, width: r.width, height: r.height }, chatTop: first.getBoundingClientRect().top, pad: parseFloat(getComputedStyle(panel).paddingTop) };
        });
        if (!where) throw new Error('the bit scene drew no chat');
        const clip = chatClip(where.panel, where.chatTop, where.pad);
        const png = path.join(tmp, 'bit.png');
        await page.screenshot({ path: png, clip });
        ffmpeg(stillArgs(png, path.join(SITE_DIR, 'bit.webp')));
        if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
        return { width: Math.round(clip.width * scale), height: Math.round(clip.height * scale) };
      } finally {
        await ctx.close();
      }
    });
  } finally {
    await app.stop();
  }
}

const RUN = { copy: async () => copyShared(), edge: buildEdge, bit: buildBit };

async function main(args) {
  const steps = pickSteps(args);
  mkdirSync(SITE_DIR, { recursive: true });
  for (const step of steps) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), `xenon-v5-${step}-`));
    try {
      console.log(JSON.stringify({ step, ...(await RUN[step](tmp)) }));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
