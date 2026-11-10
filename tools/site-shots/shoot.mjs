// Screenshots of the dashboard for the home page, on the site's own browser
// demo (canned English data, nothing from this PC), headless, at each screen's
// real size. Every request that leaves the local copy is aborted (analytics,
// fonts from other hosts, the catalog). Prints one JSON report per shot: page
// errors, page width, elements overflowing the page.
// Run: node tools/site-shots/shoot.mjs [scene ...] [--out dir]
// (default every scene, <temp>/xenon-site-shots). Needs docs/demo: node tools/build-demo.mjs

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS_DIR, startSite } from './serve.mjs';
import { SCENES, initScript } from './scenes.mjs';
import { answerRequest, moreDataFor } from './widgets.mjs';
import { fixtureFor, fixtureScript } from '../tile-previews/fixtures.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const SETTLE_MS = 3500;

// Scene names from the command line; unknown names are an error, none means all.
export function pickScenes(args) {
  const names = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
  const bad = names.filter((n) => !SCENES[n]);
  if (bad.length) throw new Error(`unknown scene: ${bad.join(', ')} (known: ${Object.keys(SCENES).join(', ')})`);
  return names.length ? names : Object.keys(SCENES);
}

// The tile's grid cell (its frame included), by the tile's id: the class name
// does not always match it (weather-tile-panel, codex-panel).
export function cropSelector(tileId) {
  if (!/^[a-z]+$/.test(tileId)) throw new Error(`bad tile id: ${tileId}`);
  return `.grid-stack-item:has([data-dashboard-widget="${tileId}"].dashboard-widget)`;
}

function measure() {
  const over = [...document.querySelectorAll('.dashboard-widget *')]
    .filter((n) => n.clientWidth && n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX === 'visible')
    .slice(0, 8).map((n) => String(n.className || n.tagName).slice(0, 60));
  // Tiles whose content runs past their own box: a clipped tile in a shot.
  const tiles = [...document.querySelectorAll('.dashboard-widget')].filter((n) => n.offsetParent);
  const clipped = tiles.filter((n) => n.scrollHeight > n.clientHeight + 2)
    .slice(0, 8).map((n) => String(n.className).split(' ').slice(1, 2).join(''));
  // Rows grown past the screen: tiles drawn below the page's own frame.
  const pager = document.querySelector('.pager');
  const frame = pager ? pager.getBoundingClientRect().bottom : innerHeight;
  const bottom = tiles.reduce((m, n) => Math.max(m, n.getBoundingClientRect().bottom), 0);
  return { pageW: document.documentElement.scrollWidth, viewW: innerWidth, belowFrame: Math.max(0, Math.round(bottom - frame)), over, clipped };
}

// Everything the scene's tiles bring with them: data, pictures, a first tap.
function sceneExtras(scene, origin) {
  const extras = (scene.fixtures || []).flatMap((id) => [fixtureFor(id), moreDataFor(id, Date.now(), origin)]).filter(Boolean);
  return {
    extras,
    served: { files: Object.assign({}, ...extras.map((x) => x.files)), frames: Object.assign({}, ...extras.map((x) => x.frames)) },
  };
}

/** Opens a scene on the demo with its data, hands the page to `use`, closes everything.
 *  `scripts` run in the page after the scene's own. */
export async function withScene(browser, base, scene, use, scripts = []) {
  const v = scene.viewport;
  const ctx = await browser.newContext({
    viewport: { width: v.width, height: v.height }, deviceScaleFactor: v.scale || 1,
    isMobile: !!v.mobile, hasTouch: !!v.mobile, locale: 'en-US', timezoneId: 'Europe/Rome',
  });
  try {
    const origin = new URL(base).origin;
    const { extras, served } = sceneExtras(scene, origin);
    await ctx.route('**/*', (r) => answerRequest(r, origin, served));
    for (const content of [initScript(scene), ...scripts]) await ctx.addInitScript({ content });
    for (const extra of extras) await ctx.addInitScript({ content: fixtureScript(extra) });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
    await page.goto(base + 'demo/', { waitUntil: 'load' });
    await page.waitForTimeout(SETTLE_MS);
    for (const { stage } of extras) if (stage) await page.evaluate(stage);
    if (scene.open) await page.evaluate(scene.open);
    await page.waitForTimeout(scene.wait || 600);
    return await use(page, errors);
  } finally {
    await ctx.close();
  }
}

export function shootScene(browser, base, scene, name, outDir) {
  return withScene(browser, base, scene, async (page, errors) => {
    const file = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: file });
    const crops = [];
    for (const [crop, tileName] of Object.entries(scene.crops || {})) {
      const tile = page.locator(cropSelector(tileName)).first();
      if (!(await tile.count())) throw new Error(`${name}: no visible ${tileName} tile to crop`);
      const cropFile = path.join(outDir, `${name}-${crop}.png`);
      await tile.screenshot({ path: cropFile });
      crops.push(cropFile);
    }
    return { scene: name, file, crops, errors, ...(await page.evaluate(measure)) };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  const outDir = path.resolve(at >= 0 ? args[at + 1] : path.join(os.tmpdir(), 'xenon-site-shots'));
  const names = pickScenes(args);
  if (!existsSync(path.join(DOCS_DIR, 'demo', 'index.html'))) throw new Error('docs/demo is missing: run node tools/build-demo.mjs first');
  await mkdir(outDir, { recursive: true });
  const site = await startSite(0);
  const browser = await loadPlaywright().chromium.launch();
  const report = [];
  try {
    for (const name of names) report.push(await shootScene(browser, `http://127.0.0.1:${site.port}/`, SCENES[name], name, outDir));
  } finally {
    await browser.close();
    await site.stop();
  }
  console.log(JSON.stringify(report, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
