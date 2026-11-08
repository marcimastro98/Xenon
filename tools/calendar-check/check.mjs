// Sweeps the Calendar through the proportions a person can give its tile, on the built
// demo, and measures what a screenshot of one size cannot show: week rows that collapse,
// numbers run through by a neighbour or by the event dots, a header wider than the tile.
// November 2026 has six weeks, the worst case.
// Run: node tools/calendar-check/check.mjs [--out <dir>] [--sizes 403x405,300x260] [--zoom 160,200] [--lang it]
// --zoom reads the sizes as real pixels and divides them, as the app's Zoom setting does:
// a WebView at 200% lays out a tile in half the CSS pixels.
// Needs docs/demo: node tools/build-demo.mjs

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { startSite } from '../site-shots/serve.mjs';
import { seedScript } from '../site-shots/desktop.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const WIDTHS = [240, 280, 320, 360, 403, 480, 560, 700, 900];
const HEIGHTS = [200, 240, 280, 320, 360, 405, 480, 560, 700, 800];
const TILES = ['agenda', 'calendar'];
const SETTLE_MS = 3500;

function argOf(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? '' : process.argv[at + 1];
}

function baseSizes() {
  const given = argOf('--sizes');
  if (given) return given.split(',').map((s) => s.split('x').map(Number));
  return WIDTHS.flatMap((w) => HEIGHTS.map((h) => [w, h]));
}

function sizes() {
  const zooms = argOf('--zoom').split(',').filter(Boolean).map((z) => Number(z) / 100);
  if (!zooms.length) return baseSizes();
  return zooms.flatMap((z) => baseSizes().map(([w, h]) => [Math.round(w / z), Math.round(h / z)]));
}

// Runs in the page. Returns what is wrong at the size the tile has now.
function measure() {
  const problems = [];
  const days = [...document.querySelectorAll('.layer-slot .day-cell:not(.empty)')];
  if (!days.length) return ['no days on screen'];
  const digits = (cell) => {
    const range = document.createRange();
    range.selectNodeContents(cell.firstChild);
    return range.getBoundingClientRect();
  };
  const rows = [...new Set(days.map((d) => Math.round(d.getBoundingClientRect().top)))].sort((a, b) => a - b);
  const heights = days.map((d) => d.getBoundingClientRect().height);
  if (Math.min(...heights) < 23.5) problems.push(`row ${Math.min(...heights).toFixed(1)}px`);
  rows.slice(1).forEach((top, i) => {
    const above = days.find((d) => Math.round(d.getBoundingClientRect().top) === rows[i]);
    if (above.getBoundingClientRect().bottom > top + 0.5) problems.push('rows overlap');
  });
  for (const day of days) {
    const box = day.getBoundingClientRect();
    const text = digits(day);
    if (text.width > box.width - 2) problems.push(`day ${day.textContent.trim()} wider than its cell`);
    const dots = day.querySelector('.day-dots');
    if (dots && dots.getBoundingClientRect().top < text.bottom - 0.5) problems.push(`dot on number ${day.textContent.trim()}`);
  }
  const card = document.querySelector('.layer-slot .calendar-card').getBoundingClientRect();
  const nav = document.querySelector('.layer-slot .calendar-nav-actions').getBoundingClientRect();
  const month = document.querySelector('.layer-slot .calendar-month');
  if (nav.right > card.right + 0.5) problems.push('header past the card');
  if (month.getBoundingClientRect().left < card.left) problems.push('month past the card');
  if (month.scrollWidth > month.clientWidth + 1) problems.push('month cut');
  if (month.getBoundingClientRect().height > 30) problems.push('month on two lines');
  const room = document.querySelector('.layer-slot .calendar-nav').getBoundingClientRect().width;
  const needed = month.getBoundingClientRect().width + nav.width + 10;
  if (nav.top >= month.getBoundingClientRect().bottom && needed <= room) problems.push('buttons wrapped with room to spare');
  for (const name of document.querySelectorAll('.layer-slot .calendar-weekdays span')) {
    if (name.scrollWidth > name.clientWidth + 1) problems.push('weekday cut');
  }
  const scroller = document.querySelector('.layer-slot :is(.cal-pane[data-calpane="calendar"], .calendar-panel)');
  if (scroller.scrollWidth > scroller.clientWidth + 1) problems.push('sideways scroll');
  return [...new Set(problems)];
}

async function sweep(page, tile, out) {
  let failed = 0;
  for (const [w, h] of sizes()) {
    await page.evaluate(([width, height]) => {
      const slot = document.querySelector('.layer-slot');
      slot.style.setProperty('--layer-w', width + 'px');
      slot.style.setProperty('--layer-h', height + 'px');
    }, [w, h]);
    await page.waitForTimeout(60);
    const problems = await page.evaluate(measure);
    if (problems.length) {
      failed += 1;
      console.log(`${tile} ${w}x${h}: ${problems.join(', ')}`);
    }
    if (out) await page.locator('.layer-slot').first().screenshot({ path: path.join(out, `${tile}-${w}x${h}.png`) });
  }
  return failed;
}

async function checkTile(browser, port, tile, out) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: out ? 2 : 1, locale: 'en-US', colorScheme: 'dark' });
  try {
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    await ctx.addInitScript({ content: seedScript([[tile, { x: 0.02, y: 0.02, w: 0.3, h: 0.5 }]]) });
    if (argOf('--lang')) await ctx.addInitScript({ content: `window.__SHOT__.settings.language = ${JSON.stringify(argOf('--lang'))};` });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/demo/?layer=desktop:site`, { waitUntil: 'load' });
    await page.waitForTimeout(SETTLE_MS);
    await page.addStyleTag({ content: 'html[data-layer],html[data-layer] body{background:#26323d!important}' });
    return await sweep(page, tile, out);
  } finally { await ctx.close(); }
}

async function run() {
  const out = argOf('--out');
  if (out) await mkdir(out, { recursive: true });
  const site = await startSite(0);
  const browser = await loadPlaywright().chromium.launch();
  let failed = 0;
  try {
    for (const tile of TILES) failed += await checkTile(browser, site.port, tile, out);
  } finally {
    await browser.close();
    await site.stop();
  }
  const total = sizes().length * TILES.length;
  console.log(failed ? `${failed} of ${total} sizes have problems` : `${total} sizes clean`);
  process.exitCode = failed ? 1 : 0;
}

await run();
