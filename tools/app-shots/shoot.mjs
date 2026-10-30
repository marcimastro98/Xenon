// Screenshots of dashboard scenes at a computer and a phone size, headless, on a
// copy served from the working tree (serve.mjs, its own free port, stopped at
// the end): never the user's Xenon server, never a visible window. Prints one
// JSON report per shot: page errors, page width, and the elements in the
// measured box that overflow it. Playwright is borrowed like toast-gallery's.
// Run: node tools/app-shots/shoot.mjs [scene ...] [--out dir]   (default: every scene, <temp>/xenon-app-shots)

import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from './serve.mjs';
import { SCENES } from './scenes.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

export const VIEWPORTS = [
  { name: 'desk', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true },
];

// Scene names from the command line; unknown names are an error, none means all.
export function pickScenes(args) {
  const names = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
  const bad = names.filter((n) => !SCENES[n]);
  if (bad.length) throw new Error(`unknown scene: ${bad.join(', ')} (known: ${Object.keys(SCENES).join(', ')})`);
  return names.length ? names : Object.keys(SCENES);
}

// Runs in the page: the box, the page width, and children wider than their own box.
function measure(sel) {
  const box = sel ? document.querySelector(sel) : document.body;
  if (!box) return { missing: sel };
  const r = box.getBoundingClientRect();
  const over = [...box.querySelectorAll('*')].filter((n) => n.clientWidth && n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX === 'visible')
    .slice(0, 10).map((n) => n.className || n.tagName);
  return { w: Math.round(r.width), h: Math.round(r.height), pageW: document.documentElement.scrollWidth, over };
}

async function shoot(browser, base, scene, v, outDir) {
  const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, isMobile: !!v.isMobile, hasTouch: !!v.hasTouch });
  try {
    for (const [p, json] of Object.entries(SCENES[scene].routes || {})) await ctx.route(`**${p}`, (r) => r.fulfill({ json }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(2000);
    const sel = await page.evaluate(SCENES[scene].open);
    await page.waitForTimeout(400);
    const file = path.join(outDir, `${scene}-${v.name}.png`);
    await page.screenshot({ path: file });
    return { scene, size: v.name, file, errors, ...(await page.evaluate(measure, sel)) };
  } finally {
    await ctx.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  const outDir = path.resolve(at >= 0 ? args[at + 1] : path.join(os.tmpdir(), 'xenon-app-shots'));
  const scenes = pickScenes(args);
  await mkdir(outDir, { recursive: true });
  const app = await startApp(0);
  const browser = await loadPlaywright().chromium.launch();
  const report = [];
  try {
    for (const scene of scenes) for (const v of VIEWPORTS) report.push(await shoot(browser, `http://127.0.0.1:${app.port}/`, scene, v, outDir));
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(JSON.stringify(report, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
