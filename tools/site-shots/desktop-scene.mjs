// The home page's "widgets on the desktop" picture: an ordinary computer desktop with
// real Xenon widgets on its wallpaper, so it reads as "they sit on the monitor you
// already have". The widgets are the demo's layer page (canned data); everything around
// them is drawn here and invented: wallpaper, window, taskbar, no system logo.
// Run: node tools/site-shots/desktop-scene.mjs [--out docs/images/home/desktop-widgets.webp]
// Needs docs/demo: node tools/build-demo.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUT_SIZE, VIEWPORT, shot } from './desktop.mjs';
import { moreDataFor } from './widgets.mjs';
import { startSite } from './serve.mjs';
import { appIcon, dataUri, landscape, webpage } from '../tile-previews/art.mjs';
import { fixtureScript } from '../tile-previews/fixtures.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const TASKBAR_PX = 48;
export const WALL = Object.freeze({ seed: 3, top: '#123b7a', bottom: '#f4a964', sun: '#fff0cf', hills: ['#5f7fa6', '#37597f', '#1a3350'], w: VIEWPORT.width, h: VIEWPORT.height });

// [tile, rect in fractions of the screen]: right of the window, above the taskbar.
export const SCENE_PLAN = [
  ['weather', { x: 0.505, y: 0.045, w: 0.225, h: 0.32 }],
  ['media', { x: 0.745, y: 0.045, w: 0.235, h: 0.32 }],
  ['system', { x: 0.505, y: 0.385, w: 0.475, h: 0.535 }],
];

const FOLDER = '<svg viewBox="0 0 48 40" width="44" height="37"><path fill="#e8b23a" d="M2 6a4 4 0 0 1 4-4h12l5 6h19a4 4 0 0 1 4 4v22a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z"/><path fill="#f7cf5e" d="M2 14h44v20a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z"/></svg>';

const desktopIcon = (label) => `<div class="di">${FOLDER}<span>${label}</span></div>`;
const taskIcon = (color, letter, on) => `<span class="ti${on ? ' on' : ''}"><img src="${dataUri(appIcon({ color, letter, w: 64 }))}" alt=""></span>`;

// The time of the shot, the one the weather tile shows beside it.
const clockText = (now) => `${now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}<br>${now.toLocaleDateString('en-GB')}`;

export function backdropHtml(now = new Date()) {
  const wall = dataUri(landscape(WALL));
  const page = dataUri(webpage({ w: 960, h: 640 }));
  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;overflow:hidden;font:400 13px/1.3 "Segoe UI",system-ui,sans-serif}
.wall{position:absolute;inset:0;background:center/cover url("${wall}")}
.icons{position:absolute;left:18px;top:18px;display:grid;gap:22px}
.di{display:grid;justify-items:center;gap:4px;width:76px;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.7)}
.win{position:absolute;left:112px;top:92px;width:586px;height:467px;border-radius:8px;overflow:hidden;background:#fff;box-shadow:0 22px 60px -14px rgba(0,0,0,.62),0 0 0 1px rgba(0,0,0,.28)}
.bar{display:flex;align-items:center;gap:10px;height:40px;padding:0 0 0 10px;background:#e7e9ec;color:#2b2f33}
.tab{display:flex;align-items:center;height:32px;margin-top:8px;padding:0 44px 0 12px;border-radius:7px 7px 0 0;background:#fff;font-weight:600}
.ctl{margin-left:auto;display:flex}.ctl i{display:block;width:44px;height:40px;position:relative}
.ctl i::after{content:"";position:absolute;left:17px;top:19px;width:10px;height:1.5px;background:#2b2f33}
.ctl i:nth-child(2)::after{top:14px;height:10px;background:none;border:1.5px solid #2b2f33}
.ctl i:nth-child(3)::before{content:"";position:absolute;left:17px;top:19px;width:10px;height:1.5px;background:#2b2f33;transform:rotate(-45deg)}
.ctl i:nth-child(3)::after{transform:rotate(45deg)}
.url{height:36px;padding:7px 12px;background:#fff;border-bottom:1px solid #dfe2e6}
.url span{display:block;height:22px;padding:2px 12px;border-radius:11px;background:#eef0f3;color:#50565c}
.win img{display:block;width:100%}
.tb{position:absolute;left:0;right:0;bottom:0;height:${TASKBAR_PX}px;display:flex;align-items:center;justify-content:center;gap:6px;background:rgba(22,27,34,.86);color:#fff}
.ti{position:relative;display:grid;place-items:center;width:40px;height:40px;border-radius:6px}.ti.on{background:rgba(255,255,255,.13)}
.ti img{width:25px;height:25px;display:block}.ti.on::after{content:"";position:absolute;bottom:2px;left:14px;right:14px;height:3px;border-radius:2px;background:#8fc7ff}
.clock{position:absolute;right:14px;top:7px;text-align:right;font-size:12px;line-height:1.35}
</style><div class="wall"></div><div class="icons">${desktopIcon('Photos')}${desktopIcon('Projects')}${desktopIcon('Games')}</div>
<div class="win"><div class="bar"><div class="tab">Lantern Trail</div><div class="ctl"><i></i><i></i><i></i></div></div><div class="url"><span>lanterntrail.example</span></div><img src="${page}" alt=""></div>
<div class="tb">${taskIcon('#e8b23a', 'F')}${taskIcon('#2f7de1', 'B', true)}${taskIcon('#7a5af5', 'M')}${taskIcon('#1fa971', 'S')}${taskIcon('#e0534a', 'V')}<div class="clock">${clockText(now)}</div></div>`;
}

async function shootBackdrop(browser, file) {
  const ctx = await browser.newContext({ viewport: { width: VIEWPORT.width, height: VIEWPORT.height }, deviceScaleFactor: VIEWPORT.scale });
  try {
    const page = await ctx.newPage();
    await page.setContent(backdropHtml(), { waitUntil: 'load' });
    await page.screenshot({ path: file });
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

// The desktop and its widgets, shot apart and laid one over the other. Returns the page's errors.
export async function shootDesktopScene(browser, base, out) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'xenon-desk-'));
  try {
    const wall = path.join(tmp, 'backdrop.png');
    const layer = path.join(tmp, 'layer.png');
    await shootBackdrop(browser, wall);
    const errors = await shot(browser, base, 'layer', layer, SCENE_PLAN, fixtureScript(moreDataFor('weather')));
    writeFileSync(out, await compose(browser, wall, layer));
    return errors;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  const out = path.resolve(at >= 0 ? args[at + 1] : path.join(os.tmpdir(), 'xenon-desktop-scene.webp'));
  const site = await startSite(0);
  const browser = await loadPlaywright().chromium.launch();
  try {
    const errors = await shootDesktopScene(browser, `http://127.0.0.1:${site.port}/`, out);
    console.log(JSON.stringify({ out, errors }));
  } finally {
    await browser.close();
    await site.stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
