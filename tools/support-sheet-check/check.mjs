// The support sheet on the real page: opened from a tagged link, its two plans, the
// line about "Pay annually", where the main key really goes, the free week only when
// this install may have it, the keyboard, and its layout at phone and desktop size in
// all 11 languages. It serves a static copy of server/ and answers every API itself,
// so no real server is touched and nothing leaves for the net. Playwright is borrowed
// as in tools/toast-gallery. Not part of `npm test`.
// Run: node tools/support-sheet-check/check.mjs [outDir]   (default: <temp>/xenon-support-sheet)

import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', 'server');
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'xenon-support-sheet'));
const LayerStrings = createRequire(import.meta.url)(path.join(ROOT, 'layers/layer-strings.js'));
const { SUPPORTED_LANGS } = createRequire(import.meta.url)(path.join(ROOT, 'shared', 'src', 'constants.js'));

const HUB = 'https://xenon-supporter-hub.xenonedge.workers.dev/go/support';
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];
const SHOT_LANGS = new Set(['en', 'it', 'de', 'ja']);
const SIZES = [
  { name: 'phone', width: 390, height: 844, scale: 2, touch: true },
  { name: 'small-phone', width: 360, height: 640, scale: 2, touch: true },
  { name: 'desktop', width: 1440, height: 900, scale: 1, touch: false },
];
const TOUCH_MIN = 44;
const BOOT_MS = 2500;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function startStatic() {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const newWorld = () => ({ trialUsed: true, saved: false, left: [] });

function apiAnswer(world, p) {
  if (p === '/api/community/supporter') return { saved: world.saved };
  if (p === '/api/community/trial') return { ok: true, state: world.trialUsed ? 'ended' : 'none', used: world.trialUsed };
  return {};
}

// On the context, so a window the sheet opens is fenced too: what tries to leave is
// written down (world.left) and refused.
async function fence(ctx, world, host) {
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const isApi = /^\/(api|sdk|events)/.test(url.pathname);
    if (url.host !== host && !isApi) { world.left.push(url.href); return route.abort(); }
    if (url.pathname === '/layer-i18n.js') {
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: await LayerStrings.scriptFor([...SUPPORTED_LANGS].sort()) });
    }
    if (!isApi) return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(apiAnswer(world, url.pathname)) }).catch(() => {});
  });
}

const results = [];
function check(name, ok, extra = '') { results.push({ name, ok: !!ok, extra: ok ? '' : String(extra) }); }

// A link as the callers write it: its own href, the label and maybe a plan.
async function openFromLink(page, source, plan) {
  await page.evaluate(({ source, plan, hub }) => {
    for (const n of document.querySelectorAll('.support-sheet-overlay')) n.remove();
    const a = document.createElement('a');
    a.id = 'check-join';
    a.href = hub + '?s=' + source;
    a.target = '_blank';
    a.textContent = 'Become a supporter';
    a.dataset.supportSource = source;
    if (plan) a.dataset.supportPlan = plan;
    a.style.cssText = 'position:fixed;left:8px;top:8px;z-index:1;padding:14px';
    document.getElementById('check-join')?.remove();
    document.body.appendChild(a);
  }, { source, plan, hub: HUB });
  await page.click('#check-join');
  await page.waitForSelector('.support-sheet', { timeout: 5000 });
  await page.waitForTimeout(120);
}

const go = (page) => page.locator('.support-sheet-go');
const hintShown = (page) => page.locator('.support-sheet-hint').isVisible();

// Run in the page: what a viewer would call broken at this size.
function measure(minTouch) {
  const sheet = document.querySelector('.support-sheet');
  const vw = document.documentElement.clientWidth;
  const shown = (n) => n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden';
  const label = (n) => `${n.tagName.toLowerCase()}.${String(n.className.baseVal ?? n.className).split(' ')[0]}`;
  const nodes = [...sheet.querySelectorAll('*')].filter(shown);
  const off = nodes.filter((n) => { const b = n.getBoundingClientRect(); return b.right > vw + 0.5 || b.left < -0.5; }).map(label);
  const clipped = nodes.filter((n) => n.matches('h2,p,button,a,label,li,span') && n.scrollWidth > n.clientWidth + 1
    && getComputedStyle(n).display !== 'inline').map(label);
  const small = [...sheet.querySelectorAll('button, a, label')].filter(shown).filter((n) => {
    const b = n.getBoundingClientRect();
    return b.height < minTouch - 0.5 || b.width < minTouch - 0.5;
  }).map((n) => `${label(n)}=${Math.round(n.getBoundingClientRect().width)}x${Math.round(n.getBoundingClientRect().height)}`);
  const goRect = sheet.querySelector('.support-sheet-go').getBoundingClientRect();
  return { pageOver: document.documentElement.scrollWidth - vw, sheetOver: sheet.scrollWidth - sheet.clientWidth, off, clipped, small, goBelow: Math.round(goRect.bottom - window.innerHeight) };
}

async function sweep(page, world, size) {
  for (const lang of LANGS) {
    await page.evaluate((l) => { window.setLang(l); }, lang);
    world.trialUsed = false;
    await openFromLink(page, 'store-locked');
    await page.waitForSelector('.support-sheet-alt:nth-child(2):not([hidden])', { timeout: 3000 }).catch(() => {});
    const m = await page.evaluate(measure, TOUCH_MIN);
    const tag = `${size.name}/${lang}`;
    check(`${tag} no sideways scroll`, m.pageOver <= 0 && m.sheetOver <= 0 && !m.off.length, JSON.stringify(m));
    check(`${tag} no clipped text`, !m.clipped.length, m.clipped.join(' '));
    check(`${tag} touch targets`, !m.small.length, m.small.join(' '));
    if (size.name !== 'small-phone') check(`${tag} the main key is on screen without scrolling`, m.goBelow <= 0, `${m.goBelow}px below`);
    check(`${tag} the "Pay annually" line is shown for yearly`, await hintShown(page) && /Pay annually/.test(await page.locator('.support-sheet-hint').textContent()));
    if (SHOT_LANGS.has(lang)) await page.screenshot({ path: path.join(OUT, `${size.name}-${lang}.png`) });
    await page.keyboard.press('Escape');
    await page.waitForSelector('.support-sheet', { state: 'detached', timeout: 3000 });
  }
}

const FLOWS = {
  async 'a tagged link opens the sheet, not the page'(page, world) {
    await openFromLink(page, 'store-locked');
    check('the sheet is open', await page.locator('.support-sheet[role="dialog"][aria-modal="true"]').count() === 1);
    check('no window left for the page', !world.left.some((u) => u.startsWith(HUB)), world.left.join(' '));
    check('yearly is picked', await page.locator('.support-sheet-plan[data-plan="yearly"] input').isChecked());
    check('yearly is listed first', (await page.locator('.support-sheet-plan').first().getAttribute('data-plan')) === 'yearly');
    check('the yearly line is shown', await hintShown(page));
    check('the main key goes to the hub with the label and the yearly plan', (await go(page).getAttribute('href')) === HUB + '?s=store-locked&p=yearly');
    check('the prices are the constant\'s', /\$50/.test(await page.locator('.support-sheet').textContent()) && /\$5/.test(await page.locator('.support-sheet').textContent()));
  },
  async 'monthly drops the plan from the link and the line'(page) {
    await openFromLink(page, 'settings');
    await page.locator('.support-sheet-plan[data-plan="monthly"]').click();
    check('monthly is the plain hub link', (await go(page).getAttribute('href')) === HUB + '?s=settings');
    check('the yearly line is gone', !(await hintShown(page)));
    await page.locator('.support-sheet-plan[data-plan="yearly"]').click();
    check('back on yearly, the line returns', await hintShown(page));
  },
  async 'a link that asks for monthly opens on monthly'(page) {
    await openFromLink(page, 'app-ask', 'monthly');
    check('monthly is picked', await page.locator('.support-sheet-plan[data-plan="monthly"] input').isChecked());
    check('its link has no plan', (await go(page).getAttribute('href')) === HUB + '?s=app-ask');
  },
  async 'the main key really leaves for the hub, with s= and p='(page, world) {
    await openFromLink(page, 'lyrics');
    const popup = page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null);
    await go(page).click();
    await popup;
    await page.waitForTimeout(400);
    check('the window asked for the hub link', world.left.includes(HUB + '?s=lyrics&p=yearly'), world.left.join(' '));
    check('the sheet closed behind it', await page.locator('.support-sheet').count() === 0);
    const tip = page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null);
    await openFromLink(page, 'lyrics');
    await page.locator('.support-sheet-once').click();
    await tip;
    await page.waitForTimeout(400);
    check('the one-time tip goes to the hub with p=once', world.left.includes(HUB + '?s=lyrics&p=once'), world.left.join(' '));
  },
  // The native shell's link catcher (EXTERNAL_LINK_SHIM in webview_setup.rs), copied
  // in its shape: on the document, in the capture phase, it takes outside _blank links.
  async 'in the native shell the sheet still comes first, and goes once the page opens'(page) {
    await page.evaluate(() => {
      window.__shim = [];
      document.addEventListener('click', (e) => {
        const a = e.target?.closest?.('a[href]');
        if (a?.target !== '_blank' || new URL(a.href).host === location.host) return;
        e.preventDefault(); e.stopPropagation(); window.__shim.push(a.href);
      }, true);
    });
    await openFromLink(page, 'devclean');
    check('the shell did not take the tagged link', (await page.evaluate(() => window.__shim.length)) === 0);
    await go(page).click();
    await page.waitForTimeout(200);
    check('the shell took the main key to the hub', (await page.evaluate(() => window.__shim.join(' '))) === HUB + '?s=devclean&p=yearly');
    check('the sheet closed', await page.locator('.support-sheet').count() === 0);
  },
  async 'the free week only when this install may have it'(page, world) {
    const trialShown = () => page.locator('.support-sheet-alt').nth(1).isVisible();
    Object.assign(world, { trialUsed: false, saved: false });
    await openFromLink(page, 'store-locked');
    await page.waitForTimeout(500);
    check('offered to an install that never had it', await trialShown());
    Object.assign(world, { trialUsed: true, saved: false });
    await openFromLink(page, 'store-locked');
    await page.waitForTimeout(500);
    check('not after the trial was used', !(await trialShown()));
    Object.assign(world, { trialUsed: false, saved: true });
    await openFromLink(page, 'store-locked');
    await page.waitForTimeout(500);
    check('not to an install that keeps a code', !(await trialShown()));
  },
  async 'the keyboard: focus inside, Tab stays, Esc and the close key leave'(page) {
    await openFromLink(page, 'store-section');
    check('the main key has the focus', await page.evaluate(() => !!document.activeElement?.classList.contains('support-sheet-go')));
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
    check('Tab stays in the sheet', await page.evaluate(() => !!document.activeElement.closest('.support-sheet')));
    await page.keyboard.press('Escape');
    check('Esc closes it', await page.locator('.support-sheet').count() === 0);
    check('the focus goes back to the link', await page.evaluate(() => document.activeElement && document.activeElement.id === 'check-join'));
    await openFromLink(page, 'store-section');
    await page.locator('.support-sheet-close').click();
    check('the close key closes it', await page.locator('.support-sheet').count() === 0);
    await openFromLink(page, 'store-section');
    await page.mouse.click(2, 2);
    check('a tap outside closes it', await page.locator('.support-sheet').count() === 0);
  },
  async 'Settings writes its prices from the same constant'(page) {
    await page.evaluate(() => { window.openSettings('support'); });
    await page.waitForTimeout(300);
    const prices = await page.evaluate(() => [...document.querySelectorAll('[data-support-price]')].map((b) => b.textContent));
    check('monthly and yearly tiles', prices.join('|') === '$5|$50', prices.join('|'));
    await page.locator('.support-plan[data-support-plan="yearly"]').click();
    await page.waitForSelector('.support-sheet', { timeout: 3000 });
    check('the yearly tile opens the sheet on yearly with its label', (await go(page).getAttribute('href')) === HUB + '?s=settings-year&p=yearly');
  },
  async 'Bit opens it with its own label'(page) {
    await page.evaluate(() => { window._aiExecuteClientAction('open_support_sheet', {}); });
    await page.waitForSelector('.support-sheet', { timeout: 3000 });
    check('the label is bit', (await go(page).getAttribute('href')) === HUB + '?s=bit&p=yearly');
  },
};

async function bootPage(browser, base, size) {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale, hasTouch: size.touch, locale: 'en-US' });
  const world = newWorld();
  await fence(ctx, world, new URL(base).host);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err?.message).slice(0, 200)));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.SupportSheet && window.TrialPass && window.setLang, null, { timeout: 30000 });
  await page.waitForTimeout(BOOT_MS);
  await page.addStyleTag({ content: '#boot-splash,.greeting-splash{display:none!important}' });
  await page.evaluate(() => { window.setLang('en'); });
  return { ctx, page, world, errors };
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startStatic();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const size of [SIZES[0], SIZES[2]]) {
      for (const [title, flow] of Object.entries(FLOWS)) {
        const { ctx, page, world, errors } = await bootPage(browser, base, size);
        const before = results.length;
        try { await flow(page, world); }
        catch (err) {
          check('flow ran to the end', false, String(err.message).slice(0, 300));
          await page.screenshot({ path: path.join(OUT, `fail-${size.name}-${title.replace(/\W+/g, '-')}.png`) });
        } finally { await ctx.close(); }
        check('no page errors', !errors.length, errors.join(' | '));
        for (const r of results.slice(before)) r.name = `${size.name}: ${title}: ${r.name}`;
      }
    }
    for (const size of SIZES) {
      const { ctx, page, world, errors } = await bootPage(browser, base, size);
      try { await sweep(page, world, size); }
      catch (err) {
        check(`${size.name} sweep ran to the end`, false, String(err.message).slice(0, 300));
        await page.screenshot({ path: path.join(OUT, `fail-${size.name}-sweep.png`) });
      } finally { await ctx.close(); }
      check(`${size.name} no page errors in the sweep`, !errors.length, errors.join(' | '));
    }
  } finally {
    await browser.close();
    server.close();
  }
  const failed = results.filter((r) => !r.ok);
  for (const r of failed) console.log(`FAIL ${r.name}: ${r.extra}`);
  console.log(`${results.length - failed.length} of ${results.length} passed. Shots in ${OUT}`);
  if (failed.length) process.exitCode = 1;
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
