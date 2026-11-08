// The pictures in the Xenon menu's "Add" list (server/assets/tile-previews/<tile>.webp):
// each tile of server/tile-previews.js shot on the site's browser demo, so everything
// in them is invented data, nothing from this PC. A tile the demo leaves empty gets a
// fixture (fixtures.mjs) and a page of its own; the others share a page, six at a time.
// Headless: a request that leaves the local copy gets the fixture's page, or is aborted.
// server/test/tile-previews.test.mjs fails when a listed tile has no picture or the
// picture is too heavy.
// Run: node tools/tile-previews/shoot.mjs [tile ...] [--out dir] [--width px] [--light]
//   (default every listed tile; a width or light is for looking at them, not for the shipped pictures)
// Needs docs/demo: node tools/build-demo.mjs

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DOCS_DIR, startSite } from '../site-shots/serve.mjs';
import { initScript, tileLayout } from '../site-shots/scenes.mjs';
import { cropSelector } from '../site-shots/shoot.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';
import { FIXTURE_TILES, fixtureFor, fixtureScript } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { PREVIEW_TILES, PREVIEW_WIDTH } = require(path.join(ROOT, 'server', 'tile-previews.js'));
const PER_PAGE = 6;
const SETTLE_MS = 4500;
const STAGE_MS = 800;
// Around the tile, never on it: the demo's "runs on your PC" veil, any toast, and the clock pill over the top row.
const SHOT_CSS = '.demo-na,.xtoast-stack,.topbar-mini{display:none!important}';

// Tile names from the command line; unknown names are an error, none means all.
export function pickTiles(args) {
  const names = args.filter((a, i) => !a.startsWith('--') && !['--out', '--width'].includes(args[i - 1]));
  const bad = names.filter((n) => !PREVIEW_TILES.includes(n));
  if (bad.length) throw new Error(`unknown tile: ${bad.join(', ')}`);
  return names.length ? names : [...PREVIEW_TILES];
}

export function batches(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// One page per tile with a fixture, so one tile's data never reaches another.
export function pageGroups(tiles) {
  const plain = tiles.filter((id) => !FIXTURE_TILES.includes(id));
  const fed = tiles.filter((id) => FIXTURE_TILES.includes(id));
  return [...batches(plain, PER_PAGE), ...fed.map((id) => [id])];
}

// A shot made smaller and turned into WebP by the browser: no image library needed.
async function toWebp(page, png, width) {
  const url = await page.evaluate(async ({ b64, w }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = w;
    c.height = Math.round(img.naturalHeight * w / img.naturalWidth);
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/webp', 0.8);
  }, { b64: png.toString('base64'), w: width });
  return Buffer.from(url.split(',')[1], 'base64');
}

// The one tile's page, with the cards its fixture hides.
export function shotLayout(tiles, fixture) {
  const layout = tileLayout(tiles);
  return fixture && fixture.cards ? { ...layout, cards: { ...layout.cards, ...fixture.cards } } : layout;
}

// Local requests go on, except a fixture's pictures. A player's page comes from the
// fixture too; everything else is aborted.
function answerRequest(route, origin, { files = {}, frames = {} }) {
  const url = new URL(route.request().url());
  if (url.origin !== origin) {
    const html = frames[url.hostname];
    return html ? route.fulfill({ status: 200, contentType: 'text/html', body: html }) : route.abort();
  }
  const file = files[url.pathname + url.search] || files[url.pathname];
  return file ? route.fulfill({ status: 200, contentType: file.type, body: file.body }) : route.continue();
}

async function shootBatch(browser, base, tiles, outDir, { width, light }) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'Europe/Rome' });
  const report = [];
  try {
    const origin = new URL(base).origin;
    const fixture = tiles.length === 1 ? fixtureFor(tiles[0]) : null;
    await ctx.route('**/*', (r) => answerRequest(r, origin, fixture || {}));
    await ctx.addInitScript({ content: initScript({ layout: shotLayout(tiles, fixture) }) });
    if (fixture) await ctx.addInitScript({ content: fixtureScript(fixture) });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
    await page.goto(base + 'demo/', { waitUntil: 'load' });
    await page.addStyleTag({ content: SHOT_CSS });
    await page.waitForTimeout(SETTLE_MS);
    if (light) await page.evaluate(() => window.setAppearance('light'));
    if (fixture && fixture.stage) {
      await page.evaluate(fixture.stage);
      await page.waitForTimeout(STAGE_MS);
    }
    for (const id of tiles) {
      const tile = page.locator((fixture && fixture.crop) || cropSelector(id)).first();
      if (!(await tile.count())) { report.push({ id, missing: true }); continue; }
      const webp = await toWebp(page, await tile.screenshot(), width);
      await writeFile(path.join(outDir, `${id}.webp`), webp);
      report.push({ id, kb: Math.round(webp.length / 102.4) / 10 });
    }
    if (errors.length) report.push({ errors: errors.slice(0, 3) });
    return report;
  } finally {
    await ctx.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  const outDir = path.resolve(at >= 0 ? args[at + 1] : path.join(ROOT, 'server', 'assets', 'tile-previews'));
  const wide = args.indexOf('--width');
  const look = { width: wide >= 0 ? Number(args[wide + 1]) : PREVIEW_WIDTH, light: args.includes('--light') };
  if (!existsSync(path.join(DOCS_DIR, 'demo', 'index.html'))) throw new Error('docs/demo is missing: run node tools/build-demo.mjs first');
  await mkdir(outDir, { recursive: true });
  const site = await startSite(0);
  const browser = await loadPlaywright().chromium.launch();
  const report = [];
  try {
    for (const group of pageGroups(pickTiles(args))) report.push(...await shootBatch(browser, `http://127.0.0.1:${site.port}/`, group, outDir, look));
  } finally {
    await browser.close();
    await site.stop();
  }
  console.log(JSON.stringify(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
