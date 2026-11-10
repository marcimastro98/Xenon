// The look of a new install in a real browser, on the built demo: what a unit test
// cannot see. At each size the page must open on Liquid Glass with the wallpaper behind
// real blur, without sideways scroll, and every tile must keep its words readable over
// the brightest spot of the wallpaper. Then the states that change the sheet: Classic and
// back, low-power GPU, reduced transparency, light mode, a widget window.
// Run: node tools/default-look-check/check.mjs
// Needs docs/demo: node tools/build-demo.mjs

import { startSite } from '../site-shots/serve.mjs';
import { seedScript } from '../site-shots/desktop.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const SIZES = [[390, 844], [1920, 1080], [2560, 720]];
const SETTLE_MS = 3400;
const AA_CONTRAST = 4.5;
const TILE_SHEET = '.grid-stack-item[data-tile-glass] > .grid-stack-item-content > :is(.panel, .dashboard-widget)';
// Everything but the sheet goes, so the measure reads what stands behind the words.
const SHEET_ONLY = `*{color:transparent!important;text-shadow:none!important;caret-color:transparent!important}
  .grid-stack-item-content :is(svg,img,canvas,button,input,.media-art,.ai-chat>*,.stat-track,.bit-chat-face){visibility:hidden!important}`;

const failures = [];
function check(name, ok, detail = '') {
  if (!ok) failures.push(`${name}${detail ? ': ' + detail : ''}`);
}

const channel = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const rgbOf = (css) => css.match(/[\d.]+/g).slice(0, 3).map(Number);

// Runs in the page: the theme's text colours, as painted.
function inkColours() {
  const paint = (name) => {
    const probe = document.createElement('i');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  };
  return { text: paint('--text'), muted: paint('--muted-text') };
}

// Runs in the page: the brightest 12 px cell inside each tile of a screenshot.
async function brightestCells(pngBase64) {
  const CELL = 12;
  const TOP_BAR = 72;
  const image = new Image();
  image.src = 'data:image/png;base64,' + pngBase64;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  const brightest = (x0, y0, w, h) => {
    const data = ctx.getImageData(x0, y0, w, h).data;
    let best = null;
    for (let y = 0; y + CELL <= h; y += CELL) {
      for (let x = 0; x + CELL <= w; x += CELL) {
        const sum = [0, 0, 0];
        for (let j = 0; j < CELL; j++) {
          for (let i = 0; i < CELL; i++) {
            const at = ((y + j) * w + x + i) * 4;
            for (let c = 0; c < 3; c++) sum[c] += data[at + c];
          }
        }
        const rgb = sum.map((v) => Math.round(v / (CELL * CELL)));
        const level = rgb[0] * 0.3 + rgb[1] * 0.59 + rgb[2] * 0.11;
        if (!best || level > best.level) best = { level, rgb };
      }
    }
    return best;
  };
  const cells = [];
  for (const tile of document.querySelectorAll('.grid-stack-item')) {
    const box = tile.getBoundingClientRect();
    if (!tile.offsetParent || box.width <= 80) continue;
    const x0 = Math.max(0, Math.round(box.left) + 10);
    const y0 = Math.max(TOP_BAR, Math.round(box.top) + 10);
    const w = Math.min(image.width - x0, Math.round(box.width) - 20);
    const h = Math.min(image.height - y0, Math.round(box.bottom) - 10 - y0);
    if (w < 16 || h < 16) continue;
    const cell = brightest(x0, y0, w, h);
    if (cell) cells.push(cell.rgb);
  }
  return cells;
}

async function checkContrast(page, label) {
  const ink = await page.evaluate(inkColours);
  await page.addStyleTag({ content: SHEET_ONLY });
  await page.waitForTimeout(350);
  const shot = await page.screenshot({ type: 'png' });
  const cells = await page.evaluate(brightestCells, shot.toString('base64'));
  check(`${label} tiles measured`, cells.length > 0);
  const worst = (colour) => Math.min(...cells.map((rgb) => contrast(luminance(rgbOf(colour)), luminance(rgb))));
  const text = worst(ink.text);
  const muted = worst(ink.muted);
  check(`${label} text contrast`, text >= AA_CONTRAST, text.toFixed(2));
  check(`${label} muted contrast`, muted >= AA_CONTRAST, muted.toFixed(2));
  console.log(`${label}: ${cells.length} tiles, worst contrast text ${text.toFixed(2)}, muted ${muted.toFixed(2)}`);
}

// Runs in the page: what the first glass tile and the page are showing now.
function readLook(selector) {
  const root = document.documentElement;
  const sheet = document.querySelector(selector);
  const wallpaper = document.getElementById('bg-static');
  const body = getComputedStyle(document.body);
  return {
    style: root.dataset.style || '',
    appearance: root.dataset.appearance || '',
    blur: sheet ? getComputedStyle(sheet).backdropFilter : '',
    alpha: body.getPropertyValue('--panel-alpha').trim(),
    wallpaper: wallpaper ? getComputedStyle(wallpaper).backgroundImage : '',
    sideways: root.scrollWidth - window.innerWidth,
    title: getComputedStyle(document.querySelector('.media-title')).color,
  };
}

async function openDemo(browser, width, height, init) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: 'en-US', colorScheme: 'dark' });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.addInitScript(() => { try { localStorage.setItem('xenon.site.consent', 'denied'); } catch { /* a blocked store only shows the card */ } });
  if (init) await ctx.addInitScript({ content: init });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors };
}

async function checkSize(browser, port, width, height) {
  const label = `${width}x${height}`;
  const { ctx, page, errors } = await openDemo(browser, width, height);
  try {
    await page.goto(`http://127.0.0.1:${port}/demo/`, { waitUntil: 'load' });
    await page.waitForTimeout(SETTLE_MS);
    const look = await page.evaluate(readLook, TILE_SHEET);
    check(`${label} opens on Liquid Glass`, look.style === 'liquid', look.style);
    check(`${label} tiles blur`, look.blur.includes('blur'), look.blur);
    check(`${label} wallpaper`, look.wallpaper.includes('dusk'), look.wallpaper.slice(0, 80));
    check(`${label} no sideways scroll`, look.sideways <= 0, String(look.sideways));
    await checkContrast(page, label);
    check(`${label} page errors`, !errors.length, errors.slice(0, 2).join(' | '));
  } finally { await ctx.close(); }
}

async function checkSettings(page) {
  const fresh = await page.evaluate(() => {
    const s = normalizeSettings({});
    return { style: s.styleMode, wallpaper: s.bgStatic.style, topbar: s.topbarStyle };
  });
  check('a new install is Liquid Glass', fresh.style === 'liquid' && fresh.wallpaper === 'dusk' && fresh.topbar === 'minimal', JSON.stringify(fresh));
  const old = await page.evaluate(() => {
    const s = normalizeSettings({ styleMode: 'glass', topbarStyle: 'full', bgStatic: { style: 'none', intensity: 50 }, panelAlpha: 0.94, clockDateFormat: 'full' });
    return { style: s.styleMode, wallpaper: s.bgStatic.style, topbar: s.topbarStyle, alpha: s.panelAlpha, date: s.clockDateFormat };
  });
  check('an old install keeps its look', old.style === 'glass' && old.wallpaper === 'none' && old.topbar === 'full' && old.alpha === 0.94 && old.date === 'full', JSON.stringify(old));
}

async function checkThemeRoundTrip(page) {
  await page.evaluate(() => applyThemeById('glass'));
  await page.waitForTimeout(500);
  const classic = await page.evaluate(readLook, TILE_SHEET);
  check('Classic drops the skin', classic.style === '', classic.style);
  await page.evaluate(() => applyThemeById('liquid'));
  await page.waitForTimeout(500);
  const back = await page.evaluate(readLook, TILE_SHEET);
  check('back to Liquid Glass', back.style === 'liquid' && back.blur.includes('blur'), JSON.stringify(back).slice(0, 120));
}

async function checkLowPower(page) {
  await page.evaluate(() => document.body.classList.add('low-power-gpu'));
  await page.waitForTimeout(200);
  const look = await page.evaluate(readLook, TILE_SHEET);
  check('low power drops the blur', !look.blur.includes('blur'), look.blur);
  check('low power thickens the sheet', look.alpha === '0.86', look.alpha);
  await page.evaluate(() => document.body.classList.remove('low-power-gpu'));
}

async function checkReducedTransparency(page, ctx) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  await page.waitForTimeout(200);
  const look = await page.evaluate(readLook, TILE_SHEET);
  check('reduced transparency drops the blur', !look.blur.includes('blur'), look.blur);
  check('reduced transparency thickens the sheet', look.alpha === '0.92', look.alpha);
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  await cdp.detach();
}

async function checkLight(page) {
  await page.evaluate(() => setAppearance('light'));
  await page.waitForTimeout(600);
  const look = await page.evaluate(readLook, TILE_SHEET);
  check('light mode is on', look.appearance === 'light', look.appearance);
  check('light mode darkens the track title', luminance(rgbOf(look.title)) < 0.2, look.title);
  await page.evaluate(() => setAppearance('dark'));
}

async function checkStates(browser, port) {
  const { ctx, page, errors } = await openDemo(browser, 1920, 1080);
  try {
    await page.goto(`http://127.0.0.1:${port}/demo/`, { waitUntil: 'load' });
    await page.waitForTimeout(SETTLE_MS);
    await checkSettings(page);
    await checkThemeRoundTrip(page);
    await checkLowPower(page);
    await checkReducedTransparency(page, ctx);
    await checkLight(page);
    check('states page errors', !errors.length, errors.slice(0, 2).join(' | '));
  } finally { await ctx.close(); }
}

async function checkWidgetWindow(browser, port) {
  const plan = [['system', { x: 0.1, y: 0.1, w: 0.3, h: 0.5 }]];
  const { ctx, page, errors } = await openDemo(browser, 1440, 810, seedScript(plan));
  try {
    await page.goto(`http://127.0.0.1:${port}/demo/?layer=desktop:site`, { waitUntil: 'load' });
    await page.waitForTimeout(SETTLE_MS);
    const tile = await page.evaluate(() => {
      const sheet = document.querySelector('.layer-slot > [data-dashboard-widget]');
      const css = getComputedStyle(sheet);
      return { fill: css.backgroundColor, blur: css.backdropFilter };
    });
    check('a widget window has a thick sheet', /, 0\.94\)$/.test(tile.fill), tile.fill);
    check('a widget window has no blur', !tile.blur.includes('blur'), tile.blur);
    check('widget window page errors', !errors.length, errors.slice(0, 2).join(' | '));
  } finally { await ctx.close(); }
}

async function run() {
  const site = await startSite(0);
  const browser = await loadPlaywright().chromium.launch();
  try {
    for (const [width, height] of SIZES) await checkSize(browser, site.port, width, height);
    await checkStates(browser, site.port);
    await checkWidgetWindow(browser, site.port);
  } finally {
    await browser.close();
    await site.stop();
  }
  failures.forEach((f) => console.log('FAIL ' + f));
  console.log(failures.length ? `${failures.length} checks failed` : 'default look clean');
  process.exitCode = failures.length ? 1 : 0;
}

await run();
