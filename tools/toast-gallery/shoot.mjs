// Screenshots of the notification gallery: every place, theme and set at the
// sizes Xenon supports, plus reduced motion. Playwright is not a dependency of
// this repo: it is borrowed from the sibling xenon-maker checkout, or from the
// folder XENON_PLAYWRIGHT names.
// Run: node tools/toast-gallery/shoot.mjs [outDir]   (default: <temp>/xenon-toast-shots)

import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGallery } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'edge', width: 2560, height: 720 },
];
export const PLACES = ['stack', 'alerts', 'island'];
export const THEMES = ['dark', 'light'];
export const SETS = ['1', '2'];

// Every shot as { file, query, viewport }.
export function shotList() {
  const out = [];
  for (const v of VIEWPORTS) for (const place of PLACES) for (const theme of THEMES) for (const set of SETS) {
    out.push({ file: `${place}-${theme}-set${set}-${v.name}.png`, query: `?place=${place}&theme=${theme}&set=${set}`, viewport: v });
  }
  return out;
}

export function loadPlaywright() {
  const from = process.env.XENON_PLAYWRIGHT || path.resolve(HERE, '..', '..', '..', 'xenon-maker', 'node_modules', 'playwright');
  return createRequire(import.meta.url)(from);
}

async function main() {
  const outDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'xenon-toast-shots'));
  await mkdir(outDir, { recursive: true });
  const { chromium } = loadPlaywright();
  const server = await startGallery(0);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  try {
    for (const motion of ['no-preference', 'reduce']) {
      const context = await browser.newContext({ reducedMotion: motion });
      try {
        const page = await context.newPage();
        const shots = motion === 'reduce' ? shotList().filter((s) => s.viewport.name === 'desktop' && s.file.includes('set1')) : shotList();
        for (const s of shots) {
          await page.setViewportSize({ width: s.viewport.width, height: s.viewport.height });
          await page.goto(base + s.query);
          await page.waitForFunction(() => window.__galleryReady === true);
          await page.waitForTimeout(900);
          const file = motion === 'reduce' ? s.file.replace('.png', '-reduced.png') : s.file;
          await page.screenshot({ path: path.join(outDir, file) });
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`Shots in ${outDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
