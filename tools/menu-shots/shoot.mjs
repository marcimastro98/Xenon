// Pictures of the Xenon menu's Screens page (server/js/menu/xenon-menu-screens.js) at every size
// and in several languages, with invented data (fixture.mjs): the real menu.html and its
// scripts, served from this checkout next to a few fake answers. No engine runs, nothing is
// read from or written to this PC. Each picture is checked for a page wider than the window.
// Playwright is borrowed as in tools/toast-gallery (../xenon-maker or XENON_PLAYWRIGHT).
// Run: node tools/menu-shots/shoot.mjs [outDir]   (default <temp>/xenon-menu-shots)
//   MENU_LANGS=it,de  MENU_SIZES=phone,edge  narrow the sweep.

import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';
import { DESKS, LOOK, menuState } from './fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER_DIR = path.join(ROOT, 'server');
const CORE_DIR = path.join(ROOT, 'packages', 'core');
const require = createRequire(import.meta.url);

export const SIZES = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'window', width: 1080, height: 720 },
  { name: 'browser', width: 1920, height: 1080 },
  { name: 'edge', width: 2560, height: 720 },
];
export const LANGS = ['it', 'en', 'de', 'ru', 'ja'];
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json' };

// A file under `base`, or null for anything that climbs out of it or reaches the user's
// data folder (server/data: settings, notes, uploads) or a dot folder, never served.
export function inside(base, rel) {
  let clean;
  try { clean = decodeURIComponent(rel); } catch { return null; }
  const file = path.resolve(base, '.' + path.posix.normalize('/' + clean));
  if (!file.startsWith(base + path.sep)) return null;
  const first = path.relative(base, file).split(path.sep)[0].toLowerCase();
  return first === 'data' || first.startsWith('.') ? null : file;
}

/** The menu page and its fake answers; `lang()` is the language the next page asks for. */
export function startMenuServer(lang, desk = DESKS[process.env.MENU_DESK] || DESKS.two) {
  const Menu = require(path.join(SERVER_DIR, 'menu', 'xenon-menu.js'));
  const LayerI18n = require(path.join(SERVER_DIR, 'layers', 'layer-strings.js'));
  const json = (res, body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    try {
      if (p === '/menu') p2(res, await readFile(path.join(SERVER_DIR, 'menu.html')), '.html');
      else if (p === '/layer-i18n.js') p2(res, await LayerI18n.scriptFor(LayerI18n.wantedLanguages(lang(), ''), lang()), '.js');
      else if (p === '/settings') json(res, { settings: { ...LOOK, language: lang() } });
      else if (p === '/screen-menu') json(res, { open: true, section: 'screens' });
      else if (p === '/xenon-menu') json(res, { ...Menu.compose(menuState({ monitors: desk.monitors })), altGrKeys: [] });
      else if (p === '/api/remote-access/status') json(res, { devices: desk.phones });
      else {
        const file = p.startsWith('/shared/') ? inside(CORE_DIR, p.slice('/shared'.length)) : inside(SERVER_DIR, p);
        if (!file) { res.writeHead(404); res.end(); return; }
        p2(res, await readFile(file), path.extname(file));
      }
    } catch {
      res.writeHead(404); res.end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function p2(res, body, ext) {
  res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(body);
}

// What a picture must not show: a page wider than its window, or a control cut by its box.
async function problems(page) {
  return page.evaluate(() => {
    const out = [];
    const doc = document.scrollingElement;
    if (doc.scrollWidth > doc.clientWidth + 1) out.push(`page scrolls sideways (${doc.scrollWidth} > ${doc.clientWidth})`);
    for (const el of document.querySelectorAll('.xm-scrname, .xm-wtab-name, .xm-wtab-value, .xm-sceneopt-name, .xm-scrchip, .xm-scrphone')) {
      const r = el.getBoundingClientRect();
      if (!r.width || getComputedStyle(el).textOverflow === 'ellipsis') continue;
      if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) out.push(`cut: ${el.className || el.tagName} "${el.textContent.trim().slice(0, 30)}"`);
    }
    return [...new Set(out)];
  });
}

async function main() {
  const outDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'xenon-menu-shots'));
  await mkdir(outDir, { recursive: true });
  const pick = (env, all) => (process.env[env] ? all.filter((x) => process.env[env].split(',').includes(x.name || x)) : all);
  const sizes = pick('MENU_SIZES', SIZES);
  const langs = pick('MENU_LANGS', LANGS);
  let lang = 'en';
  const server = await startMenuServer(() => lang);
  const base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const report = [];
  try {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      for (const code of langs) {
        lang = code;
        for (const s of sizes) {
          await page.setViewportSize({ width: s.width, height: s.height });
          await page.goto(base + '/menu', { waitUntil: 'load' });
          await page.waitForSelector('.xm-scrmap', { timeout: 8000 });
          await page.waitForTimeout(400);
          const shots = [['main', null], ['edge', () => page.locator('.xm-scrpick').nth(1).click()], ['widgets', () => page.locator('.xm-wtab').nth(1).click()]];
          for (const [name, step] of shots) {
            if (step) { await step(); await page.waitForTimeout(250); }
            const file = `${code}-${s.name}-${name}.png`;
            await page.screenshot({ path: path.join(outDir, file) });
            const found = await problems(page);
            if (found.length) report.push(`${file}: ${found.join('; ')}`);
          }
        }
      }
      if (errors.length) report.push('page errors: ' + [...new Set(errors)].join(' | '));
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`pictures in ${outDir}`);
  console.log(report.length ? report.join('\n') : 'no sideways scroll, nothing cut, no page errors');
  if (report.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
