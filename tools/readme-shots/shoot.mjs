// The pictures only the GitHub README uses, in docs/images/readme: the download keys (a
// README cannot style a link), the four screens in one strip, the overlay over a made-up
// game and the in-app Store. `features` takes the whole-window pictures of FEATURES.md into
// docs/images/features; the tile pictures beside them come from tools/tile-previews/shoot.mjs.
// Everything comes from the site's pictures and the browser demo, so nothing here shows this PC.
// Run: node tools/readme-shots/shoot.mjs [keys screens game store features] [--out dir] [--catalog file]
// --catalog: the Store's list when the repo's docs/community/catalog.json is behind the live one.
// Needs docs/demo (node tools/build-demo.mjs) and the site's pictures (tools/site-shots/publish.mjs).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS_DIR, startSite } from '../site-shots/serve.mjs';
import { toWebp } from '../site-shots/widgets.mjs';
import { gamePieces } from '../store-shots/shoot.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

export const OUT_DIR = path.join(DOCS_DIR, 'images', 'readme');
export const FEATURES_DIR = path.join(DOCS_DIR, 'images', 'features');
const HOME_PICTURES = path.join(DOCS_DIR, 'images', 'home');

// The height of the official Microsoft Store badge they stand beside.
export const KEY_HEIGHT = 44;
export const KEYS = [
  { file: 'download-windows.png', symbol: 'os-win', label: 'Download for Windows', main: true },
  { file: 'download-macos.png', symbol: 'os-mac', label: 'macOS', note: 'beta' },
  { file: 'download-linux.png', symbol: 'os-linux', label: 'Linux', note: 'beta' },
];

// Left to right, standing on one line at about their real proportions.
export const SCREENS = [
  { file: 'screen-monitor.webp', width: 760 },
  { file: 'screen-edge.webp', width: 169 },
  { file: 'screen-tablet.webp', width: 470 },
  { file: 'screen-phone.webp', width: 170 },
];
const SCREEN_GAP = 24;

const GAME = { width: 1280, height: 720, sky: '#10122e', artTop: 60 };
const STORE = { width: 1600, height: 900 };
const STORE_SETTLE_MS = 3500;
const DEMO_CSS = '#demo-badge,#demo-convert,.demo-na,.xtoast-stack{display:none!important}';

// What a tile picture cannot show. `settings` is a Settings page, `provider` the answer picked on it,
// `bar` the top bar's style; `width` a window of its own, `height` only the top of it. A laptop's window at twice its
// pixels: GitHub shows these about 900 px wide, where a monitor's Settings text would be too small to read.
export const FEATURE_VIEW = { width: 1280, height: 800 };
const FEATURE_SCALE = 2;
const FEATURE_WIDTH = 1600;
const FEATURE_SETTLE_MS = 900;
export const FEATURE_SHOTS = [
  { file: 'layout-mode.webp', layout: true },
  { file: 'settings-appearance.webp', settings: 'appearance' },
  { file: 'settings-bit.webp', settings: 'ai', provider: 'xenon' },
  { file: 'settings-sharing.webp', settings: 'sdk' },
  { file: 'settings-performance.webp', settings: 'performance' },
  { file: 'topbar-full.webp', bar: 'full', height: 76, width: 1800 },
  { file: 'topbar-minimal.webp', bar: 'minimal' },
];
// A README lives for months: the Store it shows leads with a piece that stays, not this month's drop.
export const STORE_HERO = 'lakeside';
const STORE_SIDE = ['afterimage', 'pagina-100'];
const SEASONAL_ENTRY = /^haunted-house/;
const REPO_CATALOG = path.join(DOCS_DIR, 'community', 'catalog.json');

const webpUri = (file) => `data:image/webp;base64,${readFileSync(path.join(HOME_PICTURES, file)).toString('base64')}`;
const pngUri = (file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;

/** HTML drawn on a transparent page, its first element saved as WebP. */
async function savedWebp(browser, html, viewport, file, width) {
  const ctx = await browser.newContext({ viewport });
  try {
    const page = await ctx.newPage();
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}</style>${html}`, { waitUntil: 'load' });
    const png = await page.locator('body > :not(style)').first().screenshot({ omitBackground: true });
    writeFileSync(file, await toWebp(page, png, width));
  } finally {
    await ctx.close();
  }
}

export function keyCss() {
  return `html, body { background: transparent !important; }
body > :not(.rk) { display: none !important; }
.rk { display: inline-flex; align-items: center; gap: 10px; box-sizing: border-box; height: ${KEY_HEIGHT}px; padding: 0 18px;
  border-radius: 4px; border: 1px solid #5a6068; background: #202020; color: #fff; white-space: nowrap;
  font: 700 17px/1 var(--f-display); letter-spacing: .004em; }
.rk.main { border-color: #6ee787; background: #6ee787; color: #0b2412; }
.rk svg { width: 18px; height: 18px; flex: none; }
.rk small { font: 500 14px/1 var(--f-display); color: #c4c9cf; }`;
}

/** Drawn on the home page: its fonts and its marks, nothing retyped. */
async function keys(browser, base, out) {
  const ctx = await browser.newContext({ viewport: { width: 500, height: 200 }, deviceScaleFactor: 3 });
  try {
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({ content: keyCss() });
    for (const key of KEYS) {
      await page.evaluate(async ({ symbol, label, note, main }) => {
        document.querySelector('.rk')?.remove();
        const el = document.createElement('div');
        el.className = main ? 'rk main' : 'rk';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', `#${symbol}`);
        svg.append(use);
        el.append(svg, label);
        if (note) el.append(Object.assign(document.createElement('small'), { textContent: note }));
        document.body.append(el);
        await document.fonts.ready;
      }, key);
      await page.locator('.rk').screenshot({ path: path.join(out, key.file), omitBackground: true });
    }
  } finally {
    await ctx.close();
  }
}

export function screensHtml(uri = webpUri) {
  const tags = SCREENS.map(({ file, width }) => `<img src="${uri(file)}" width="${width}" alt="">`).join('');
  return `<div style="display:inline-flex;align-items:flex-end;gap:${SCREEN_GAP}px">${tags}</div>`;
}

const screens = (browser, out) => {
  const width = SCREENS.reduce((sum, s) => sum + s.width, 0) + SCREEN_GAP * (SCREENS.length - 1);
  return savedWebp(browser, screensHtml(), { width, height: 800 }, path.join(out, 'screens.webp'), width);
};

/** The overlay at the size it has on a 1920 screen, over a smaller game: its numbers read at README width.
 * The art sits lower than its frame so the readings stand on the sky, not on the skyline. */
async function game(browser, base, out, tmp) {
  const { game: art, layer } = await gamePieces(browser, base, tmp);
  const html = `<div style="position:relative;overflow:hidden;width:${GAME.width}px;height:${GAME.height}px;background:${GAME.sky} url('${pngUri(art)}') 0 ${GAME.artTop}px/100% no-repeat">
<img src="${pngUri(layer)}" style="position:absolute;left:0;top:0" alt=""></div>`;
  await savedWebp(browser, html, GAME, path.join(out, 'game-overlay.webp'), GAME.width);
}

export function evergreenCatalog(catalog) {
  const entries = catalog.entries
    .filter((entry) => !SEASONAL_ENTRY.test(entry.id))
    .map((entry) => {
      if (entry.id === STORE_HERO) return { ...entry, featured: 'main' };
      return STORE_SIDE.includes(entry.id) ? { ...entry, featured: 'on' } : entry;
    });
  return { ...catalog, entries };
}

async function openDemo(ctx, base) {
  await ctx.addInitScript({ content: `try{localStorage.setItem('xeneonedge.bootLook.v1','{"off":true}');localStorage.setItem('xenon.site.consent','denied')}catch{}` });
  const page = await ctx.newPage();
  await page.goto(`${base}demo/`, { waitUntil: 'load' });
  await page.waitForTimeout(STORE_SETTLE_MS);
  await page.addStyleTag({ content: DEMO_CSS });
  return page;
}

async function store(browser, base, out, catalog) {
  const ctx = await browser.newContext({ viewport: STORE, locale: 'en-US', timezoneId: 'Europe/Rome' });
  try {
    const list = evergreenCatalog(JSON.parse(readFileSync(catalog || REPO_CATALOG, 'utf8')));
    await ctx.route('**/community/catalog.json*', (r) => r.fulfill({ json: list }));
    const page = await openDemo(ctx, base);
    await page.evaluate(() => window.CommunityGallery.open());
    await page.waitForTimeout(STORE_SETTLE_MS);
    writeFileSync(path.join(out, 'store.webp'), await toWebp(page, await page.screenshot(), STORE.width));
  } finally {
    await ctx.close();
  }
}

async function stageFeature(page, shot) {
  if (shot.bar) await page.evaluate((style) => window.updateTopbarStyle(style), shot.bar);
  if (shot.layout) await page.evaluate(() => window.setDashboardLayoutEditMode(true));
  if (shot.settings) {
    await page.evaluate(() => window.openSettings());
    await page.waitForTimeout(FEATURE_SETTLE_MS);
    await page.evaluate((id) => window.settingsSetCategory(id), shot.settings);
  }
  if (shot.provider) await page.evaluate((id) => document.getElementById(`ai-provider-${id}`).click(), shot.provider);
  await page.waitForTimeout(FEATURE_SETTLE_MS);
}

/** One context per picture: a bar style or an open Settings never reaches the next one. */
async function features(browser, base, out) {
  mkdirSync(out, { recursive: true });
  for (const shot of FEATURE_SHOTS) {
    const view = { ...FEATURE_VIEW, width: shot.width || FEATURE_VIEW.width };
    const ctx = await browser.newContext({ viewport: view, deviceScaleFactor: FEATURE_SCALE, locale: 'en-US', timezoneId: 'Europe/Rome' });
    try {
      const page = await openDemo(ctx, base);
      await stageFeature(page, shot);
      const clip = { x: 0, y: 0, width: view.width, height: shot.height || view.height };
      writeFileSync(path.join(out, shot.file), await toWebp(page, await page.screenshot({ clip }), FEATURE_WIDTH));
    } finally {
      await ctx.close();
    }
  }
}

const RUNNERS = {
  keys: ({ browser, base, out }) => keys(browser, base, out),
  screens: ({ browser, out }) => screens(browser, out),
  game: ({ browser, base, out, tmp }) => game(browser, base, out, tmp),
  store: ({ browser, base, out, catalog }) => store(browser, base, out, catalog),
  features: ({ browser, base, featuresOut }) => features(browser, base, featuresOut),
};

export function pickPictures(args) {
  const named = args.filter((a, i) => !a.startsWith('--') && !['--out', '--catalog'].includes(args[i - 1]));
  const bad = named.filter((id) => !RUNNERS[id]);
  if (bad.length) throw new Error(`unknown picture: ${bad.join(', ')} (known: ${Object.keys(RUNNERS).join(', ')})`);
  return named.length ? named : Object.keys(RUNNERS);
}

const option = (args, name) => (args.includes(name) ? path.resolve(args[args.indexOf(name) + 1]) : null);

async function main() {
  const args = process.argv.slice(2);
  const ids = pickPictures(args);
  const out = option(args, '--out') || OUT_DIR;
  const featuresOut = option(args, '--out') || FEATURES_DIR;
  const catalog = option(args, '--catalog');
  if (!existsSync(path.join(DOCS_DIR, 'demo'))) throw new Error('docs/demo is missing: node tools/build-demo.mjs');
  mkdirSync(out, { recursive: true });
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'xenon-readme-'));
  const site = await startSite(0);
  const browser = await loadPlaywright().chromium.launch();
  try {
    const context = { browser, out, featuresOut, tmp, catalog, base: `http://127.0.0.1:${site.port}/` };
    for (const id of ids) {
      await RUNNERS[id](context);
      console.log(id);
    }
  } finally {
    await browser.close();
    await site.stop();
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
