// Widgets on a desktop, headless, on the site's own browser demo (canned English
// data, nothing from this PC, no Windows wallpaper): the demo's bare ambient scene
// is the wallpaper, the demo opened as a layer page (?layer=desktop:site) draws the
// placed widgets on a transparent page, and the two are composed into one WebP.
// The home's picture is desktop-scene.mjs, built on these shots; the What's New
// widgets clip takes them apart.
// Run: node tools/site-shots/desktop.mjs [--out file.webp]
// Needs docs/demo: node tools/build-demo.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSite } from './serve.mjs';
import { SCENES, initScript } from './scenes.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

export const OUT_SIZE = { width: 1600, height: 900 };
// A 1440 wide desktop: the tiles keep the size they have on a real monitor.
export const VIEWPORT = { width: 1440, height: 810, scale: 3 };
const SETTLE_MS = 5000;

// [tile, rect in fractions of the screen].
export const PLAN = [
  ['agenda', { x: 0.405, y: 0.045, w: 0.28, h: 0.58 }],
  ['media', { x: 0.7, y: 0.045, w: 0.28, h: 0.245 }],
  ['system', { x: 0.7, y: 0.31, w: 0.28, h: 0.6 }],
];

export function desktopLayers(plan = PLAN) {
  return {
    enabled: true,
    widgets: plan.map(([widget, rect], i) => ({ id: `lw_site${i}`, kind: 'tile', widget, surface: 'desktop', monitor: 'site', rect })),
  };
}

// The wallpaper scene is bare: its clock sits in the middle, under the widgets.
export function seedScript(plan = PLAN) {
  return `${initScript({ layout: SCENES.monitor.layout })}
window.__SHOT__.settings.layers = ${JSON.stringify(desktopLayers(plan))};
window.__SHOT__.settings.lockWidgets = { clock: false, weather: false, media: false, calendar: false };`;
}

export async function shot(browser, base, mode, file, plan = PLAN, extraScript = '') {
  const v = VIEWPORT;
  const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: v.scale, locale: 'en-US', timezoneId: 'Europe/Rome' });
  try {
    await ctx.route('**/*', (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
    await ctx.addInitScript({ content: seedScript(plan) });
    if (extraScript) await ctx.addInitScript({ content: extraScript });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
    await page.goto(base + (mode === 'layer' ? 'demo/?layer=desktop:site' : 'demo/'), { waitUntil: 'load' });
    await page.waitForTimeout(SETTLE_MS);
    if (mode === 'wallpaper') {
      await page.evaluate(() => window.AmbientMode.open());
      // The wallpaper has no close key: only the ambient view opened by hand shows it.
      await page.addStyleTag({ content: '.lockscreen-exit{display:none!important}' });
      await page.waitForTimeout(3000);
    }
    const slots = await page.evaluate(() => document.querySelectorAll('.layer-slot').length);
    if (mode === 'layer' && slots !== plan.length) throw new Error(`layer page drew ${slots} of ${plan.length} widgets`);
    await page.screenshot({ path: file, omitBackground: mode === 'layer' });
    return errors;
  } finally {
    await ctx.close();
  }
}

async function compose(browser, bg, fg) {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    const data = (f) => 'data:image/png;base64,' + readFileSync(f).toString('base64');
    const url = await page.evaluate(async ({ bg, fg, width, height }) => {
      const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
      const c = document.createElement('canvas');
      c.width = width; c.height = height;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(await load(bg), 0, 0, width, height);
      g.drawImage(await load(fg), 0, 0, width, height);
      return c.toDataURL('image/webp', 0.86);
    }, { bg: data(bg), fg: data(fg), ...OUT_SIZE });
    return Buffer.from(url.split(',')[1], 'base64');
  } finally {
    await ctx.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  const out = path.resolve(at >= 0 ? args[at + 1] : path.join(os.tmpdir(), 'xenon-desktop-widgets.webp'));
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'xenon-desk-'));
  const site = await startSite(0);
  const browser = await loadPlaywright().chromium.launch();
  try {
    const base = `http://127.0.0.1:${site.port}/`;
    const wall = path.join(tmp, 'wallpaper.png');
    const layer = path.join(tmp, 'layer.png');
    const errors = [...await shot(browser, base, 'wallpaper', wall), ...await shot(browser, base, 'layer', layer)];
    writeFileSync(out, await compose(browser, wall, layer));
    console.log(JSON.stringify({ out, errors }));
  } finally {
    await browser.close();
    await site.stop();
    await rm(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
