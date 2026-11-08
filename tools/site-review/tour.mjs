// A quick look at every site page: first view and full height, one theme, one width. Outside
// requests are blocked, so nothing leaves this PC and the page is seen with its fallbacks.
// Run: node tools/site-review/tour.mjs [--out dir] [--theme light|dark] [--width n] [page ...]

import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSite } from '../site-shots/serve.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

export const PAGES = [
  '/', '/download.html', '/faq.html', '/widgets.html', '/claude-code.html', '/codex.html', '/deck.html',
  '/fps-overlay.html', '/linux.html', '/mac.html', '/phone.html', '/privacy.html', '/releases.html',
  '/screen-recorder.html', '/sensor-panel.html', '/single-screen.html', '/tablet-dashboard.html', '/thanks.html',
  '/xeneon-edge-widgets.html', '/xenon-exe.html', '/404.html', '/catalog/', '/create/', '/get/', '/submit/',
];
const PHONE_BELOW = 700;

export function parseArgs(argv) {
  const o = { out: path.join(os.tmpdir(), 'xenon-site-tour'), theme: 'light', width: 1440, pages: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--theme') o.theme = argv[++i] === 'dark' ? 'dark' : 'light';
    else if (a === '--width') o.width = Number(argv[++i]);
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o.pages.push(a);
  }
  if (!(o.width >= 280 && o.width <= 3840)) throw new Error('--width takes 280 to 3840');
  if (!o.pages.length) o.pages = PAGES;
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  await mkdir(o.out, { recursive: true });
  const site = await startSite(0);
  const base = `http://127.0.0.1:${site.port}`;
  const browser = await loadPlaywright().chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: o.width, height: o.width < PHONE_BELOW ? 844 : 900 }, colorScheme: o.theme, locale: 'en-US',
  });
  try {
    await ctx.addInitScript(() => { try { localStorage.setItem('xenon.site.consent', 'denied'); } catch { /* private mode */ } });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    for (const [i, url] of o.pages.entries()) {
      errors.length = 0;
      await page.goto(base + url, { waitUntil: 'load' });
      await page.waitForTimeout(350);
      const m = await page.evaluate(() => ({
        h: document.documentElement.scrollHeight,
        over: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      }));
      const name = String(i).padStart(3, '0');
      await page.screenshot({ path: path.join(o.out, `${name}.jpg`), type: 'jpeg', quality: 72 });
      await page.screenshot({ path: path.join(o.out, `full-${name}.jpg`), type: 'jpeg', quality: 60, fullPage: true });
      console.log(name, url, m.h, m.over ? 'OVERFLOW' : '', errors.join(' | '));
    }
  } finally {
    await ctx.close();
    await browser.close();
    await site.stop();
  }
  console.log(`shots: ${o.out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
