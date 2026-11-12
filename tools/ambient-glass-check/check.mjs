// The Ambient clock's glass digits on a PC that draws on its integrated GPU, in a real
// browser on the built demo. Over a still picture of the user's own the digits must stay
// glass; over a video or GIF wallpaper, which keeps moving, they go solid to spare the GPU.
// The demo's LockScreen.css is swapped for the working tree's on the fly (docs/ is the
// live site and is never written), so the check runs before a demo rebuild.
// --old serves the demo's own stylesheet instead, to see what a build before the fix did.
// Run: node tools/ambient-glass-check/check.mjs [--old] [--shots <dir>]
// Needs docs/demo: node tools/build-demo.mjs

import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSite } from '../site-shots/serve.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKING_CSS = path.resolve(HERE, '..', '..', 'server', 'components', 'LockScreen', 'LockScreen.css');
const SETTLE_MS = 2500;
const OPEN_MS = 1500;

// [label, body classes, data-bg-type, glass expected]. No data-bg-static: none of these
// is one of Xenon's built-in still wallpapers.
const CASES = [
  ['own still picture, strong GPU', [], 'image', true],
  ['own still picture, integrated GPU', ['low-power-gpu'], 'image', true],
  ['video wallpaper, integrated GPU', ['low-power-gpu'], 'video', false],
  ['GIF wallpaper, integrated GPU', ['low-power-gpu'], 'gif', false],
  ['still picture, Performance Mode', ['perf-mode'], 'image', false],
];

const args = process.argv.slice(2);
const useOld = args.includes('--old');
const shotsAt = args.indexOf('--shots');
const shotsDir = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : '';

// Runs in the page: what the glass digits paint right now.
function readGlass() {
  const glass = document.querySelector('.lock-digits-glass');
  if (!glass || !glass.getClientRects().length) return null;
  const style = getComputedStyle(glass);
  return { backdrop: style.backdropFilter, background: style.backgroundImage !== 'none' ? style.backgroundImage : style.backgroundColor };
}

async function runCase(browser, port, css, [label, classes, bgType, wantGlass]) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'en-US', colorScheme: 'dark' });
  try {
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    await ctx.addInitScript(() => { try { localStorage.setItem('xenon.site.consent', 'denied'); } catch { /* a blocked store only shows the card */ } });
    if (css) await ctx.route('**/components/LockScreen/LockScreen.css', (r) => r.fulfill({ contentType: 'text/css', body: css }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/demo/`, { waitUntil: 'load' });
    await page.waitForTimeout(SETTLE_MS);
    await page.evaluate(({ classes, bgType }) => {
      document.body.classList.remove('low-power-gpu', 'perf-mode');
      for (const name of classes) document.body.classList.add(name);
      delete document.body.dataset.bgStatic;
      document.body.dataset.bgType = bgType;
      return window.AmbientMode.open({ manual: true });
    }, { classes, bgType });
    await page.waitForTimeout(OPEN_MS);
    const glass = await page.evaluate(readGlass);
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, label.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.png') });
    if (!glass) return { label, ok: false, detail: 'no glass digits on screen' };
    const isGlass = glass.backdrop.includes('blur');
    const ok = isGlass === wantGlass && !errors.length;
    const detail = `${isGlass ? 'glass' : 'solid'} (want ${wantGlass ? 'glass' : 'solid'}), backdrop ${glass.backdrop}` +
      (errors.length ? `, errors: ${errors.slice(0, 2).join(' | ')}` : '');
    return { label, ok, detail };
  } finally { await ctx.close(); }
}

async function main() {
  if (shotsDir) await mkdir(shotsDir, { recursive: true });
  const css = useOld ? '' : await readFile(WORKING_CSS, 'utf8');
  const { chromium } = loadPlaywright();
  const { port, stop } = await startSite(0);
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const c of CASES) results.push(await runCase(browser, port, css, c));
  } finally {
    await browser.close();
    await stop();
  }
  console.log(useOld ? 'Stylesheet: docs/demo (before the fix)' : 'Stylesheet: server/ working tree');
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.label}: ${r.detail}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `${failed} of ${results.length} failed` : `all ${results.length} pass`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
