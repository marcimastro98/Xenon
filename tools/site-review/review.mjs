// Review a site page the way a visitor meets it: every width, light and dark,
// several languages. For each pass it saves a full-page shot plus one shot per
// section, and measures sideways overflow, touch targets under 44 px (24 px with a mouse), clipped
// text, WCAG AA contrast, LCP and the layout shifts (PerformanceObserver, no
// extra packages). Phones and tablets load with a throttled CPU and network.
// Nothing is sent anywhere: analytics hosts and every non-GET request are
// blocked; --offline blocks every outside request (tests the fallbacks).
// Run: node tools/site-review/review.mjs [--page /] [--widths 390,1440] [--themes light,dark]
//      [--langs en,it,ja] [--out dir] [--offline] [--no-shots]

import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSite } from '../site-shots/serve.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';
import { PAGE_LIB, VITALS_INIT, auditPage, problems } from './checks.mjs';

export const DEFAULTS = { page: '/', widths: [390, 768, 1024, 1440, 1920], themes: ['light', 'dark'], langs: ['en', 'it', 'ja'] };
// 44 px where people tap (Apple HIG, WCAG 2.5.5), 24 px for a mouse (WCAG 2.5.8 AA).
export const MIN_TARGET = { touch: 44, pointer: 24 };
// Phone, tablet portrait, small laptop, laptop, desktop.
export const HEIGHTS = { 390: 844, 768: 1024, 1024: 768, 1440: 900, 1920: 1080 };
const BLOCKED_HOSTS = ['googletagmanager.com', 'google-analytics.com', 'cloudflareinsights.com'];
// Lighthouse's mobile profile: 150 ms round trip, 1.6 Mbps down, CPU 4x slower.
const MOBILE_NET = { offline: false, latency: 150, downloadThroughput: (1638.4 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 };

export function parseArgs(argv) {
  const o = { ...DEFAULTS, out: path.join(os.tmpdir(), 'xenon-site-review'), offline: false, shots: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const list = () => String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (a === '--page') o.page = argv[++i];
    else if (a === '--widths') o.widths = list().map(Number).filter((n) => n >= 280 && n <= 3840);
    else if (a === '--themes') o.themes = list().filter((t) => t === 'light' || t === 'dark');
    else if (a === '--langs') o.langs = list().filter((l) => /^[a-z]{2}$/.test(l));
    else if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--offline') o.offline = true;
    else if (a === '--no-shots') o.shots = false;
    else throw new Error(`unknown option ${a}`);
  }
  if (!o.widths.length || !o.themes.length || !o.langs.length) throw new Error('empty --widths, --themes or --langs');
  return o;
}

// English lives at the root, the other languages under /<lang>/.
export function pageUrl(base, page, lang) {
  const p = page.startsWith('/') ? page : `/${page}`;
  return base.replace(/\/$/, '') + (lang === 'en' ? p : `/${lang}${p}`);
}

export function allowRequest(url, method, base, offline) {
  if (url.startsWith(base) || url.startsWith('data:') || url.startsWith('blob:')) return true;
  if (offline || method !== 'GET') return false;
  let host;
  try { host = new URL(url).hostname; } catch { return false; }
  return !BLOCKED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

const isMobile = (w) => w < 1024;
export const viewportFor = (w) => ({ width: w, height: HEIGHTS[w] || Math.round(isMobile(w) ? w * 2.16 : w * 0.5625) });

// The hub answers only xenon-app.com, so its CORS refusal on 127.0.0.1 is the
// test bench, not the page; resource failures are logged with their address.
export function pageError(text) {
  if (/blocked by CORS policy/.test(text) || /^Failed to load resource/.test(text)) return null;
  return text.slice(0, 200);
}

async function reviewOne(browser, base, o, width, theme, lang) {
  const tag = `${lang}-${theme}-${width}`;
  const ctx = await browser.newContext({
    viewport: viewportFor(width),
    deviceScaleFactor: isMobile(width) ? 2 : 1, isMobile: width < 768, hasTouch: isMobile(width),
    colorScheme: theme, locale: lang, reducedMotion: 'no-preference',
  });
  try {
    await ctx.route('**/*', (r) => (allowRequest(r.request().url(), r.request().method(), base, o.offline) ? r.continue() : r.abort()));
    await ctx.addInitScript({ content: `${VITALS_INIT}\ntry { localStorage.removeItem('xenon.site.theme'); localStorage.setItem('xenon.site.lang', ${JSON.stringify(lang)}); } catch (e) {}` });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
    page.on('console', (m) => { const e = m.type() === 'error' && pageError(m.text()); if (e) errors.push(e); });
    page.on('response', (res) => { if (res.status() >= 400 && res.url().startsWith(base)) errors.push(`${res.status()} ${res.url().slice(base.length)}`); });
    if (isMobile(width)) {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Network.emulateNetworkConditions', MOBILE_NET);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }
    await page.goto(pageUrl(base, o.page, lang), { waitUntil: 'load', timeout: 90000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1500);
    const lcp = await page.evaluate(() => ({ lcp: window.__rv.lcp, lcpEl: window.__rv.lcpEl }));
    const dir = path.join(o.out, tag);
    if (o.shots) {
      await mkdir(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, '00-first-visit.jpg'), type: 'jpeg', quality: 80 });
    }
    // A returning visitor: cookie choice made, promo closed.
    for (const sel of ['.xc-no', '.xp-x']) {
      for (const b of await page.$$(sel)) if (await b.isVisible()) await b.click().catch(() => {});
    }
    // Walk down the page so lazy images load and their shifts are counted.
    await page.evaluate(async () => {
      const step = Math.round(innerHeight * 0.8);
      for (let y = 0; y < document.documentElement.scrollHeight; y += step) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
      scrollTo(0, 0);
    });
    await page.waitForTimeout(800);
    await page.addScriptTag({ content: PAGE_LIB });
    const audit = await page.evaluate(auditPage, { minTarget: isMobile(width) ? MIN_TARGET.touch : MIN_TARGET.pointer });
    const vitals = await page.evaluate(() => ({ cls: window.__rv.cls, shifts: window.__rv.shifts.slice(0, 12) }));
    const result = { tag, width, theme, lang, ...audit, ...lcp, ...vitals, errors };
    if (o.shots) {
      await page.screenshot({ path: path.join(dir, '_full.jpg'), fullPage: true, type: 'jpeg', quality: 70 });
      // One shot per screenful, as someone scrolling sees it (10% overlap).
      const total = await page.evaluate(() => document.documentElement.scrollHeight);
      const step = Math.round(viewportFor(width).height * 0.9);
      for (let y = 0, i = 1; y < total; y += step, i++) {
        await page.evaluate((top) => scrollTo(0, top), y);
        await page.waitForTimeout(250);
        await page.screenshot({ path: path.join(dir, `${String(i).padStart(2, '0')}-at-${y}.jpg`), type: 'jpeg', quality: 80 });
      }
    }
    return result;
  } finally {
    await ctx.close();
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  await mkdir(o.out, { recursive: true });
  const site = await startSite(0, { gzip: true });
  const browser = await loadPlaywright().chromium.launch();
  const results = [];
  try {
    const base = `http://127.0.0.1:${site.port}`;
    for (const lang of o.langs) for (const theme of o.themes) for (const width of o.widths) {
      const r = await reviewOne(browser, base, o, width, theme, lang);
      results.push(r);
      const p = problems(r);
      console.log(`${r.tag.padEnd(16)} LCP ${String(Math.round(r.lcp)).padStart(5)} ms  CLS ${r.cls.toFixed(3)}  ${p.length ? p.join('; ') : 'ok'}`);
    }
  } finally {
    await browser.close();
    await site.stop();
  }
  await writeFile(path.join(o.out, 'report.json'), JSON.stringify(results, null, 2));
  console.log(`report: ${path.join(o.out, 'report.json')}`);
  if (results.some((r) => problems(r).length)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
