// The pictures of the first question (server/js/usage-ask-picture.js): what a new install
// looks like at each shape of screen, an ordinary desktop, and the three first widgets.
// Shot on the site's own demo, so everything in them is invented, nothing from this PC.
// server/test/first-run-pictures.test.mjs fails when one is missing or too heavy.
// Run: node tools/first-run-shots/shoot.mjs [--out dir]   (default server/assets/first-run)
// Needs docs/demo: node tools/build-demo.mjs

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WALL, backdropHtml } from '../site-shots/desktop-scene.mjs';
import { VIEWPORT, shot } from '../site-shots/desktop.mjs';
import { DOCS_DIR, startSite } from '../site-shots/serve.mjs';
import { withScene } from '../site-shots/shoot.mjs';
import { moreDataFor } from '../site-shots/widgets.mjs';
import { dataUri, landscape } from '../tile-previews/art.mjs';
import { fixtureScript } from '../tile-previews/fixtures.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOT_CSS = '#demo-badge,#demo-convert,.demo-na,.xtoast-stack{display:none!important}';
const FIXTURES = ['weather', 'calendar'];
const QUALITY = 0.82;

// [file, the screen it is shot on, the width it is kept at]. The default layout, as on a
// new install: the app arranges it for each shape by itself.
export const DASHBOARDS = [
  ['dash-wide', { width: 1920, height: 1080, scale: 1 }, 1280],
  ['dash-edge', { width: 2560, height: 720, scale: 1 }, 1600],
  ['dash-tall', { width: 1080, height: 1920, scale: 1 }, 540],
  ['dash-phone', { width: 390, height: 844, scale: 2, mobile: true }, 300],
];
export const DESK = ['desk', 1280];
// A screen too narrow or too flat for a window keeps the wallpaper alone, without its sun: it
// crops well at any shape and leaves the eye on the screens that hold something.
export const DESK_PLAIN = ['desk-plain', 1280];

// The first widgets (js/usage-ask-plan.js STARTERS), side by side on one layer page, at
// about the shape they take on a desktop.
export const WIDGET_WIDTH = 360;
export const WIDGETS = [
  ['weather', { x: 0, y: 0.1, w: 0.33, h: 0.5 }],
  ['media', { x: 0.335, y: 0.1, w: 0.33, h: 0.5 }],
  ['system', { x: 0.67, y: 0.1, w: 0.33, h: 0.5 }],
];

// A PNG turned into a WebP by the browser, cut to `rect` (fractions of the picture) if
// there is one: no image library needed, and a transparent page stays transparent.
async function toWebp(browser, png, width, rect = { x: 0, y: 0, w: 1, h: 1 }) {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    const url = await page.evaluate(async ({ b64, width: w, rect: r, quality }) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const sx = img.naturalWidth * r.x;
      const sy = img.naturalHeight * r.y;
      const sw = img.naturalWidth * r.w;
      const sh = img.naturalHeight * r.h;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = Math.round(sh * w / sw);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
      return c.toDataURL('image/webp', quality);
    }, { b64: png.toString('base64'), width, rect, quality: QUALITY });
    return Buffer.from(url.split(',')[1], 'base64');
  } finally {
    await ctx.close();
  }
}

async function shootDashboard(browser, base, viewport) {
  return withScene(browser, base, { viewport, fixtures: FIXTURES }, async (page, errors) => {
    if (errors.length) throw new Error(`the demo broke: ${errors[0]}`);
    await page.addStyleTag({ content: SHOT_CSS });
    await page.waitForTimeout(300);
    return page.screenshot();
  });
}

const plainWall = () => `<!doctype html><style>html,body{margin:0;height:100%}img{display:block;width:100%;height:100%}</style><img alt="" src="${dataUri(landscape({ ...WALL, sun: 'none' }))}">`;

async function shootDesk(browser, html) {
  const ctx = await browser.newContext({ viewport: { width: VIEWPORT.width, height: VIEWPORT.height }, deviceScaleFactor: 2 });
  try {
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    return await page.screenshot();
  } finally {
    await ctx.close();
  }
}

async function shootWidgets(browser, base, dir) {
  const file = path.join(dir, 'layer.png');
  const errors = await shot(browser, base, 'layer', file, WIDGETS, fixtureScript(moreDataFor('weather')));
  if (errors.length) throw new Error(`the layer page broke: ${errors[0]}`);
  return readFileSync(file);
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  const out = path.resolve(at >= 0 ? args[at + 1] : path.join(ROOT, 'server', 'assets', 'first-run'));
  if (!existsSync(path.join(DOCS_DIR, 'demo', 'index.html'))) throw new Error('docs/demo is missing: run node tools/build-demo.mjs first');
  await mkdir(out, { recursive: true });
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'xenon-first-run-'));
  const site = await startSite(0);
  const browser = await loadPlaywright().chromium.launch();
  const save = async (name, data) => { await writeFile(path.join(out, `${name}.webp`), data); console.log(name, data.length); };
  try {
    const base = `http://127.0.0.1:${site.port}/`;
    for (const [name, viewport, width] of DASHBOARDS) await save(name, await toWebp(browser, await shootDashboard(browser, base, viewport), width));
    await save(DESK[0], await toWebp(browser, await shootDesk(browser, backdropHtml()), DESK[1]));
    await save(DESK_PLAIN[0], await toWebp(browser, await shootDesk(browser, plainWall()), DESK_PLAIN[1]));
    const layer = await shootWidgets(browser, base, tmp);
    for (const [name, rect] of WIDGETS) await save(`widget-${name}`, await toWebp(browser, layer, WIDGET_WIDTH, rect));
  } finally {
    await browser.close();
    await site.stop();
    await rm(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
