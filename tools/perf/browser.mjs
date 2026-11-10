// The dashboard in a headless browser, loaded as the native shell loads it: the service worker
// never registers there, and a page it serves measures something else. Numbers are headless
// Chromium, not the real WebView2. Playwright is not a dependency of this repo: it is borrowed from
// the sibling xenon-maker checkout, or from the folder XENON_PLAYWRIGHT names. CHROME_EXE picks the
// browser. Point these tools at a test copy of the server, never at the one in daily use: a
// dashboard that opens can write settings.
import { createRequire } from 'node:module';
import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEWPORT = { width: 2560, height: 720 };
const LOAD_TIMEOUT_MS = 60000;

function loadPlaywright() {
  const from = process.env.XENON_PLAYWRIGHT || path.resolve(HERE, '..', '..', '..', 'xenon-maker', 'node_modules', 'playwright');
  return createRequire(import.meta.url)(from);
}

// `beforeLoad` receives the context, for scripts that must run ahead of the page's own.
export async function withDashboard(port, run, { beforeLoad } = {}) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXE || undefined });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block' });
    try {
      if (beforeLoad) await beforeLoad(context);
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: LOAD_TIMEOUT_MS });
      return await run({ browser, page });
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

// Outside a game the lock screen covers the page within about 40 seconds and changes what draws.
export function keepLockScreenAway(page) {
  return page.evaluate(() => {
    const away = () => {
      document.body.classList.remove('lock-screen-active');
      const overlay = document.getElementById('lockscreen-overlay');
      if (overlay) overlay.hidden = true;
    };
    away();
    setInterval(away, 500);
  });
}

// Trace events per second by name. A trace raises CPU a lot: never read CPU during one.
export async function eventRates(browser, page, names, ms = 2000) {
  const tracePath = path.join(os.tmpdir(), `xenon-perf-${process.pid}.json`);
  await browser.startTracing(page, { path: tracePath, categories: ['blink', 'cc', 'devtools.timeline'] });
  await page.waitForTimeout(ms);
  await browser.stopTracing();
  const { traceEvents } = JSON.parse(readFileSync(tracePath, 'utf8'));
  rmSync(tracePath, { force: true });
  const perSecond = (name) => Math.round(traceEvents.filter((event) => event.name === name && event.ph !== 'M').length / (ms / 1000));
  return Object.fromEntries(names.map((name) => [name, perSecond(name)]));
}

// Share of one core per process type of the browser, over `ms`.
export async function browserCpu(browser, page, ms) {
  const session = await browser.newBrowserCDPSession();
  const read = async () => {
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    const totals = {};
    for (const { type, cpuTime } of processInfo) totals[type] = (totals[type] || 0) + cpuTime;
    return totals;
  };
  const start = await read();
  await page.waitForTimeout(ms);
  const end = await read();
  return Object.fromEntries(Object.keys(end).map((type) => [type, ((end[type] - (start[type] || 0)) / (ms / 1000)) * 100]));
}

export const formatCpu = (shares) => Object.entries(shares)
  .filter(([, share]) => share >= 0.05)
  .map(([type, share]) => `${type.replace(/\.mojom.*/, '')} ${share.toFixed(1)}%`)
  .join(', ');
