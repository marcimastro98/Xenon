// The Microsoft Store pictures, 1920x1080 PNG, English, on the site's browser demo and
// the app's own pages with invented data (fixtures.mjs): nothing from this PC, no real
// server touched. Every picture is checked for size and for other companies' names.
// Run: node tools/store-shots/shoot.mjs [id ...] [--out dir]   (default <temp>/xenon-store-shots)
// Needs docs/demo: node tools/build-demo.mjs

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS_DIR, startSite } from '../site-shots/serve.mjs';
import { SCENES, initScript } from '../site-shots/scenes.mjs';
import { withScene } from '../site-shots/shoot.mjs';
import { desktopLayers } from '../site-shots/desktop.mjs';
import { SCENE_PLAN, backdropHtml } from '../site-shots/desktop-scene.mjs';
import { moreDataFor } from '../site-shots/widgets.mjs';
import { skyline, dataUri } from '../tile-previews/art.mjs';
import { fixtureScript } from '../tile-previews/fixtures.mjs';
import { startApp } from '../app-shots/serve.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';
import { SHOTS, SIZE, findBrands, pageWords, pngSize, relabelScript } from './plan.mjs';
import { GALLERY_ART, galleryAnswer, menuState } from './fixtures.mjs';
import { sheetHtml } from './sheet.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SETTLE_MS = 4500;
const serverModule = (name) => createRequire(import.meta.url)(path.join(ROOT, 'server', name));
const XenonMenu = serverModule('xenon-menu.js');
const LayerStrings = serverModule('layer-strings.js');
// Demo notes, plus a music service's own logo and the lyrics provider's name.
const HIDE_DEMO_NOTES = '.demo-na,.xtoast-stack,.media-app-icon,.lyv-credit{display:none!important}';
const WALL_ZOOM = SIZE.width / 1440;

const PERF_PLAN = [['perf', { x: 0.015, y: 0.03, w: 0.3, h: 0.34 }]];

// The site's monitor at the Store's size, the Deck in the stocks' place: a ticker is a
// list of real companies, and the Store pictures name none.
function storeScene() {
  const { monitor } = SCENES;
  const { stocks: deck, ...widgets } = monitor.layout.widgets;
  return {
    ...monitor,
    viewport: { ...SIZE, scale: 1 },
    fixtures: monitor.fixtures.filter((id) => id !== 'stocks'),
    layout: { ...monitor.layout, widgets: { ...widgets, deck } },
    deck: { cols: 3, rows: 4 },
    crops: {},
  };
}

async function open(browser, base, scripts = [], options = {}) {
  const ctx = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'Europe/Rome', ...options });
  await ctx.route('**/*', (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  for (const content of [relabelScript(), ...scripts]) await ctx.addInitScript({ content });
  return { ctx, page: await ctx.newPage() };
}

/** The picture of a page, and the other companies' names it shows after the relabelling. */
async function picture(page, file, options = {}) {
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__relabel());
  const brands = findBrands(await page.evaluate(pageWords));
  await page.screenshot({ path: file, ...options });
  return brands;
}

function dashboard(browser, base, file) {
  return withScene(browser, base, storeScene(), async (page) => {
    await page.addStyleTag({ content: HIDE_DEMO_NOTES });
    return picture(page, file);
  }, [relabelScript()]);
}

const layerSeed = (plan, surface) => `${initScript({ layout: SCENES.monitor.layout })}
const seeded = ${JSON.stringify(desktopLayers(plan))};
seeded.widgets.forEach((w) => { w.surface = ${JSON.stringify(surface)}; });
window.__SHOT__.settings.layers = seeded;`;

/** The widgets alone, on a transparent page, as the shell's layer window draws them. */
async function layerPicture(browser, base, plan, surface, file) {
  const { ctx, page } = await open(browser, base, [layerSeed(plan, surface), fixtureScript(moreDataFor('weather'))]);
  try {
    await page.goto(`${base}demo/?layer=${surface}:site`, { waitUntil: 'load' });
    await page.waitForTimeout(SETTLE_MS);
    await page.addStyleTag({ content: HIDE_DEMO_NOTES });
    return await picture(page, file, { omitBackground: true });
  } finally {
    await ctx.close();
  }
}

/** Pictures stacked into one PNG at the Store's size. */
async function stack(browser, layers, file) {
  const ctx = await browser.newContext({ viewport: SIZE });
  try {
    const page = await ctx.newPage();
    const tags = layers.map((f) => `<img src="data:image/png;base64,${readFileSync(f).toString('base64')}">`).join('');
    await page.setContent(`<!doctype html><style>html,body{margin:0}img{position:absolute;inset:0;width:${SIZE.width}px;height:${SIZE.height}px}</style>${tags}`, { waitUntil: 'load' });
    await page.screenshot({ path: file });
  } finally {
    await ctx.close();
  }
}

async function htmlPicture(browser, html, file) {
  const ctx = await browser.newContext({ viewport: SIZE });
  try {
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: file });
    return findBrands(await page.evaluate(() => document.body.innerText));
  } finally {
    await ctx.close();
  }
}

/** The invented desktop, drawn at 1440 like the site's and scaled to the Store's width. */
const wallPicture = (browser, file) => {
  const html = backdropHtml().replace('<style>', `<style>html{zoom:${WALL_ZOOM}}`);
  return htmlPicture(browser, html, file);
};

async function desktop(browser, base, file, tmp) {
  const wall = path.join(tmp, 'desktop-wall.png');
  const layer = path.join(tmp, 'desktop-layer.png');
  await wallPicture(browser, wall);
  const brands = await layerPicture(browser, base, SCENE_PLAN, 'desktop', layer);
  await stack(browser, [wall, layer], file);
  return brands;
}

/** The made-up game and the overlay's readings on a transparent page, as two PNGs. */
export async function gamePieces(browser, base, tmp) {
  const game = path.join(tmp, 'game.png');
  const layer = path.join(tmp, 'perf-layer.png');
  const art = dataUri(skyline({ seed: 7, w: SIZE.width, h: SIZE.height }));
  // Pushed down so the readings sit on the sky, not on the buildings.
  await htmlPicture(browser, `<!doctype html><style>html,body{margin:0;height:100%;background:#10122e url("${art}") 0 240px/100% no-repeat}</style>`, game);
  const brands = await layerPicture(browser, base, PERF_PLAN, 'overlay', layer);
  return { game, layer, brands };
}

async function performance(browser, base, file, tmp) {
  const { game, layer, brands } = await gamePieces(browser, base, tmp);
  await stack(browser, [game, layer], file);
  return brands;
}

// The real window's size (layers/menu_window.rs), drawn larger so its words read on the Store.
const MENU_WINDOW = { width: 1080, height: 720 };
const MENU_ZOOM = 1.3;   // clear of the invented taskbar
// What a new install starts on (DEFAULT_HUB_SETTINGS in server.js).
const NEW_INSTALL_LOOK = { styleMode: 'liquid', accent: '#6ee787', background: '#14181c', text: '#f0f3f1', panelAlpha: 0.54 };

/** A picture of a window, centred on another picture. */
function windowOver(browser, wall, picture, zoom, file) {
  const uri = (f) => `data:image/png;base64,${readFileSync(f).toString('base64')}`;
  return htmlPicture(browser, `<!doctype html><style>html,body{margin:0;height:100%;background:center/cover url("${uri(wall)}")}
img{position:absolute;left:50%;top:50%;width:${MENU_WINDOW.width * zoom}px;transform:translate(-50%,-50%);border-radius:10px}</style><img src="${uri(picture)}" alt="">`, file);
}

async function menu(browser, app, file, tmp) {
  const wall = path.join(tmp, 'menu-wall.png');
  const panel = path.join(tmp, 'menu-panel.png');
  await wallPicture(browser, wall);
  const { ctx, page } = await open(browser, app, ['window.__XENON_NATIVE__=true;window.__XENON_NATIVE_CAPS__={layers:true,menu:true};window.__XENON_LAYER_SHELL__=true;'], { viewport: MENU_WINDOW, deviceScaleFactor: MENU_ZOOM, colorScheme: 'dark' });
  const json = (body) => (r) => (r.request().method() === 'GET' ? r.fulfill({ json: body }) : r.fulfill({ json: { ok: true } }));
  // A regular expression: a glob would also catch js/xenon-menu.js.
  await page.route(/\/xenon-menu(\?|$)/, json(XenonMenu.compose(menuState(Date.now()))));
  await page.route('**/settings', json({ settings: { language: 'en', ...NEW_INSTALL_LOOK } }));
  await page.route('**/screen-menu', json({ open: true, where: 'screen', section: 'now' }));
  const strings = await LayerStrings.scriptFor(['en']);
  await page.route('**/layer-i18n.js', (r) => r.fulfill({ contentType: 'text/javascript', body: strings }));
  try {
    await page.goto(app + 'menu.html', { waitUntil: 'load' });
    await page.waitForTimeout(2000);
    const brands = await picture(page, panel);
    await windowOver(browser, wall, panel, MENU_ZOOM, file);
    return brands;
  } finally {
    await ctx.close();
  }
}

function gallery(browser, base, file) {
  const captures = `window.__SHOT__.answers['/captures'] = ${JSON.stringify(galleryAnswer(Date.now()))};`;
  return withScene(browser, base, storeScene(), async (page) => {
    await page.route('**/captures/thumb*', (r) => {
      const i = Number(new URL(r.request().url()).searchParams.get('id').slice(1));
      r.fulfill({ contentType: 'image/svg+xml', body: GALLERY_ART[i]() });
    });
    await page.addStyleTag({ content: HIDE_DEMO_NOTES });
    await page.evaluate(() => window.CaptureGallery.open({}));
    await page.waitForTimeout(1500);
    return picture(page, file);
  }, [relabelScript(), captures]);
}

const RUNNERS = {
  dashboard: ({ browser, base, file }) => dashboard(browser, base, file),
  desktop: ({ browser, base, file, tmp }) => desktop(browser, base, file, tmp),
  menu: ({ browser, app, file, tmp }) => menu(browser, app, file, tmp),
  performance: ({ browser, base, file, tmp }) => performance(browser, base, file, tmp),
  gallery: ({ browser, base, file }) => gallery(browser, base, file),
  bit: ({ browser, file }) => htmlPicture(browser, sheetHtml('bit'), file),
  maker: ({ browser, file }) => htmlPicture(browser, sheetHtml('maker'), file),
};

export function pickShots(args) {
  const ids = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
  const known = SHOTS.map((s) => s.id);
  const bad = ids.filter((id) => !known.includes(id));
  if (bad.length) throw new Error(`unknown picture: ${bad.join(', ')} (known: ${known.join(', ')})`);
  return ids.length ? ids : known;
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  const out = path.resolve(at >= 0 ? args[at + 1] : path.join(os.tmpdir(), 'xenon-store-shots'));
  const ids = pickShots(args);
  if (!existsSync(path.join(DOCS_DIR, 'demo'))) throw new Error('docs/demo is missing: node tools/build-demo.mjs');
  const tmp = path.join(out, '.work');
  mkdirSync(tmp, { recursive: true });
  const site = await startSite(0);
  const appServer = await startApp(0);
  const browser = await loadPlaywright().chromium.launch();
  let failed = false;
  try {
    const context = { browser, tmp, base: `http://127.0.0.1:${site.port}/`, app: `http://127.0.0.1:${appServer.port}/` };
    for (const id of ids) {
      const n = SHOTS.findIndex((s) => s.id === id) + 1;
      const file = path.join(out, `${n}-${id}.png`);
      const brands = await RUNNERS[id]({ ...context, file });
      const size = pngSize(readFileSync(file));
      const ok = !brands.length && size.width === SIZE.width && size.height === SIZE.height;
      failed = failed || !ok;
      console.log(JSON.stringify({ id, ok, size, brands }));
    }
  } finally {
    await browser.close();
    await appServer.stop();
    await site.stop();
  }
  writeFileSync(path.join(out, 'captions.txt'), SHOTS.map((s, i) => `${i + 1}. ${s.caption}`).join('\n') + '\n');
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
