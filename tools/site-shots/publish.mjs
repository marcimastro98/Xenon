// Every dashboard picture of the site, rebuilt on the browser demo and written where
// the pages read it. Prints what each shot reported; a page error stops nothing, so read it.
// Run: node tools/site-shots/publish.mjs [scenes|themes|ambient|tiles|desktop ...] [--out dir]
// (default all five, docs/images/home). Needs docs/demo: node tools/build-demo.mjs

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shootDesktopScene } from './desktop-scene.mjs';
import { DOCS_DIR, startSite } from './serve.mjs';
import { SCENES } from './scenes.mjs';
import { shootScene } from './shoot.mjs';
import { HERO_THEMES } from './themes.mjs';
import { shootTile, toWebp } from './widgets.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const HOME_IMAGES = path.join(DOCS_DIR, 'images', 'home');
const HERO_WIDTHS = [['', 2560], ['-1440', 1440]];
const TILE_SCALE = 2;
const TILE_WIDTH = 1400;
const AMBIENT_FIXTURES = ['weather', 'calendar'];
// Only an Ambient opened by hand has a close key.
const AMBIENT_OPEN = `window.AmbientMode.open();
document.head.append(Object.assign(document.createElement('style'), { textContent: '.lockscreen-exit{display:none!important}' }));`;
const AMBIENT_SETTLE_MS = 3000;

// Each scene's pictures, as [file, width].
export const SCENE_PICTURES = {
  edge: HERO_WIDTHS.map(([suffix, width]) => [`edge-liquid${suffix}`, width]),
  'edge-vertical': [['screen-edge', 300]],
  monitor: [['screen-monitor', 1200], ['monitor', 1600]],
  tablet: [['screen-tablet', 760]],
  phone: [['phone', 780], ['screen-phone', 320]],
};

// Tile alone on the wallpaper: its picture. The home's words read w-<word>.
export const TILE_PICTURES = {
  discord: 'w-discord', spotify: 'w-spotify', weather: 'w-weather', system: 'w-system', football: 'w-football',
  youtube: 'w-youtube', twitch: 'w-twitch', calendar: 'w-calendar', deck: 'w-deck', smarthome: 'w-smarthome',
  news: 'w-news', stocks: 'w-stocks', obs: 'w-obs', claude: 'w-claude', openaicodex: 'crop-codex', agenda: 'crop-calendar',
  custom: 'w-steam', perf: 'perf-hud', media: 'crop-media', chat: 'bit-chat',
};

async function writeSized(page, png, outDir, pictures) {
  for (const [name, width] of pictures) await writeFile(path.join(outDir, `${name}.webp`), await toWebp(page, png, width));
}

// A scene shot once, then scaled to each picture by the browser that turns it into WebP.
async function publishScene(browser, base, scene, name, pictures, { outDir, tmp, helper }) {
  const report = await shootScene(browser, base, scene, name, tmp);
  await writeSized(helper, await readFile(report.file), outDir, pictures);
  return { name, errors: report.errors, belowFrame: report.belowFrame, clipped: report.clipped };
}

async function publishScenes(browser, base, job) {
  const reports = [];
  for (const [name, pictures] of Object.entries(SCENE_PICTURES)) reports.push(await publishScene(browser, base, SCENES[name], name, pictures, job));
  return reports;
}

async function publishThemes(browser, base, job) {
  const reports = [];
  for (const [id, make] of Object.entries(HERO_THEMES)) {
    const { settings, open = '' } = make();
    const scene = { ...SCENES.edge, settings, open: `${SCENES.edge.open} ${open}`, crops: {} };
    reports.push(await publishScene(browser, base, scene, `edge-${id}`, HERO_WIDTHS.map(([suffix, width]) => [`edge-${id}${suffix}`, width]), job));
  }
  return reports;
}

// The home shows each theme's dashboard, then this.
async function publishAmbient(browser, base, job) {
  const reports = [];
  for (const [id, make] of Object.entries(HERO_THEMES)) {
    const { settings, open = '' } = make();
    const scene = { ...SCENES.edge, fixtures: AMBIENT_FIXTURES, settings, open: `${open} ${AMBIENT_OPEN}`, wait: AMBIENT_SETTLE_MS, crops: {} };
    reports.push(await publishScene(browser, base, scene, `amb-${id}`, HERO_WIDTHS.map(([suffix, width]) => [`amb-${id}${suffix}`, width]), job));
  }
  return reports;
}

async function publishTiles(browser, base, { outDir }) {
  const reports = [];
  for (const [id, name] of Object.entries(TILE_PICTURES)) {
    reports.push(await shootTile(browser, base, id, { outDir, scale: TILE_SCALE, width: TILE_WIDTH, file: `${name}.webp` }));
  }
  return reports;
}

async function publishDesktop(browser, base, { outDir }) {
  return { errors: await shootDesktopScene(browser, base, path.join(outDir, 'desktop-widgets.webp')) };
}

const STEPS = { scenes: publishScenes, themes: publishThemes, ambient: publishAmbient, tiles: publishTiles, desktop: publishDesktop };

// Step names from the command line; unknown names are an error, none means all.
export function pickSteps(args) {
  const names = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
  const bad = names.filter((n) => !STEPS[n]);
  if (bad.length) throw new Error(`unknown step: ${bad.join(', ')} (known: ${Object.keys(STEPS).join(', ')})`);
  return names.length ? names : Object.keys(STEPS);
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  const outDir = path.resolve(at >= 0 ? args[at + 1] : HOME_IMAGES);
  const steps = pickSteps(args);
  if (!existsSync(path.join(DOCS_DIR, 'demo', 'index.html'))) throw new Error('docs/demo is missing: run node tools/build-demo.mjs first');
  await mkdir(outDir, { recursive: true });
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'xenon-publish-'));
  const site = await startSite(0);
  const browser = await loadPlaywright().chromium.launch();
  const context = await browser.newContext();
  try {
    const job = { outDir, tmp, helper: await context.newPage() };
    const base = `http://127.0.0.1:${site.port}/`;
    for (const step of steps) console.log(JSON.stringify({ [step]: await STEPS[step](browser, base, job) }));
  } finally {
    await context.close();
    await browser.close();
    await site.stop();
    await rm(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
