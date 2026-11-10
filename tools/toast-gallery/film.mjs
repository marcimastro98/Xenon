// Film strips of the notification animations: each scene is played in the
// gallery with every animation slowed down (Chromium's own playback rate, so
// CSS transitions and WAAPI alike), a frame is taken at a fixed step, and the
// frames are laid out on one contact sheet per scene, each marked with its
// time at real speed. Playwright as in shoot.mjs.
// Run: node tools/toast-gallery/film.mjs [outDir] [scene ...] [--theme light] [--width 1440]
// Scenes: see SCENES below; default all. Default outDir: <temp>/xenon-toast-film

import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGallery } from './serve.mjs';
import { loadPlaywright } from './shoot.mjs';

// `before` runs and settles at full speed; `act` is what gets filmed.
// Times are real-speed milliseconds.
export const SCENES = {
  'stack-arrive': { place: 'stack', act: 'gallery.show(1, 3)', ms: 640 },
  'stack-push': { place: 'stack', before: ['gallery.show(1, 0)', 'gallery.show(1, 2)'], act: 'gallery.show(1, 3)', ms: 640 },
  'stack-leave': { place: 'stack', before: ['gallery.show(1, 3)', 'gallery.show(1, 2)', 'gallery.show(1, 0)'], act: 'gallery.dismiss(gallery.ids[1])', ms: 520 },
  'island-open': { place: 'island', act: 'gallery.show(1, 3)', ms: 720 },
  'island-next': { place: 'island', before: ['gallery.show(1, 0)'], act: 'gallery.show(1, 2)', ms: 640 },
  'island-list': { place: 'island', before: ['gallery.show(1, 3)', 'gallery.show(1, 2)', 'gallery.show(1, 0)'], act: 'gallery.openList()', ms: 640 },
  'island-close': { place: 'island', before: ['gallery.show(1, 3)'], act: 'gallery.dismiss(gallery.ids[0])', ms: 640 },
};
const SLOW = 10;     // animations run this many times slower while filmed
const FRAMES = 12;

// The real-speed time of each frame of a scene.
export function frameTimes(ms, frames = FRAMES) {
  return Array.from({ length: frames }, (_, i) => Math.round((ms * i) / (frames - 1)));
}

function sheetHtml(name, frames) {
  const cells = frames.map((f) => `<figure><img src="data:image/png;base64,${f.png}"><figcaption>${f.t} ms</figcaption></figure>`).join('');
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:16px;background:#202326;color:#ddd;font:13px system-ui}
    h1{font-size:15px;margin:0 0 12px}
    main{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
    figure{margin:0}img{width:100%;display:block;border-radius:6px}figcaption{padding:4px 2px}
  </style><h1>${name}</h1><main>${cells}</main>`;
}

async function film(browser, base, name, scene, opts) {
  const context = await browser.newContext({ viewport: { width: opts.width, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(`${base}?place=${scene.place}&theme=${opts.theme}&empty=1`);
    await page.waitForFunction(() => window.__galleryReady === true);
    for (const step of scene.before || []) { await page.evaluate(step); await page.waitForTimeout(500); }
    await page.waitForTimeout(800);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 / SLOW });
    const clip = { x: Math.round((opts.width - 600) / 2), y: 0, width: 600, height: 440 };
    const times = frameTimes(scene.ms);
    const started = Date.now();
    await page.evaluate(scene.act);
    const frames = [];
    for (const t of times) {
      const due = started + t * SLOW;
      const wait = due - Date.now();
      if (wait > 0) await page.waitForTimeout(wait);
      const png = (await page.screenshot({ clip })).toString('base64');
      frames.push({ t: Math.round((Date.now() - started) / SLOW), png });
    }
    const sheet = await context.newPage();
    await sheet.setViewportSize({ width: 1400, height: 900 });
    await sheet.setContent(sheetHtml(`${name} (${opts.theme}, ${opts.width}px)`, frames));
    const file = path.join(opts.outDir, `${name}-${opts.theme}.png`);
    await sheet.screenshot({ path: file, fullPage: true });
    return file;
  } finally {
    await context.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n, d) => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
  const theme = flag('--theme', 'dark');
  const width = Number(flag('--width', 1440));
  const outDir = path.resolve(args[0] && !SCENES[args[0]] ? args.shift() : path.join(os.tmpdir(), 'xenon-toast-film'));
  const names = args.length ? args : Object.keys(SCENES);
  const unknown = names.filter((n) => !SCENES[n]);
  if (unknown.length) throw new Error(`Unknown scene: ${unknown.join(', ')}`);
  await mkdir(outDir, { recursive: true });
  const { chromium } = loadPlaywright();
  const server = await startGallery(0);
  const browser = await chromium.launch();
  try {
    const base = `http://127.0.0.1:${server.address().port}/`;
    for (const n of names) console.log(await film(browser, base, n, SCENES[n], { theme, width, outDir }));
  } finally {
    await browser.close();
    server.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
