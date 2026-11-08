// What a warm load spends: scripts by the time they run, style and layout by the line of code that
// forced them, and the API calls that repeat in the first seconds. A trace slows the page, so read
// these numbers against each other, not as the time a user waits.
//   node tools/perf/boot-trace.mjs <port> [windowMs]
import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDashboard } from './browser.mjs';

const CATEGORIES = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.stack'];
const DEFAULT_WINDOW_MS = 1500;
const WARM_UP_MS = 3000;
const CALLS_WINDOW_MS = 6000;
const ROWS = 16;
const STATIC_FILE = /\.(js|css|png|webp|svg|woff2?|ico|jpg|mp3|html)$/;

const fileOf = (url) => String(url || '').replace(/^.*\//, '').replace(/\?.*$/, '');
const lineOf = (frame) => `${frame.functionName || 'anonymous'}@${fileOf(frame.url)}:${frame.lineNumber}`;
const stackOf = (event) => event.args?.beginData?.stackTrace || event.args?.data?.stackTrace || [];

function total(rows, key, ms) {
  const row = rows.get(key) || { key, ms: 0, passes: 0 };
  row.ms += ms;
  row.passes += 1;
  rows.set(key, row);
}

const heaviestFirst = (rows) => [...rows.values()].sort((a, b) => b.ms - a.ms);

export function scriptCosts(events) {
  const rows = new Map();
  for (const event of events) {
    if (event.name === 'EvaluateScript' && event.dur) total(rows, fileOf(event.args?.data?.url), event.dur / 1000);
  }
  return heaviestFirst(rows);
}

// Style and layout inside the first `windowMs` after the navigation. A pass with no script on its
// stack is the browser's own, in a frame; the others stopped a script to answer it.
export function forcedPasses(events, windowMs) {
  const navigation = events.find((event) => event.name === 'navigationStart' && String(event.args?.data?.documentLoaderURL || '').startsWith('http'));
  // Not every browser build writes the event: the clock then starts at the first thing traced.
  const zero = navigation ? navigation.ts : events.reduce((first, event) => (event.ts && event.ts < first ? event.ts : first), Infinity);
  const lines = new Map();
  const sums = { style: 0, layout: 0 };
  for (const event of events) {
    if ((event.name !== 'UpdateLayoutTree' && event.name !== 'Layout') || !event.dur) continue;
    const at = (event.ts - zero) / 1000;
    if (at < 0 || at > windowMs) continue;
    const ms = event.dur / 1000;
    sums[event.name === 'Layout' ? 'layout' : 'style'] += ms;
    const [top] = stackOf(event);
    total(lines, top ? lineOf(top) : 'by the browser', ms);
  }
  return { ...sums, lines: heaviestFirst(lines) };
}

export function repeatedCalls(urls) {
  const counts = new Map();
  for (const url of urls) {
    const { pathname } = new URL(url);
    if (pathname === '/' || STATIC_FILE.test(pathname)) continue;
    counts.set(pathname, (counts.get(pathname) || 0) + 1);
  }
  const all = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return { all, repeated: [...counts].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]) };
}

async function traceLoad(browser, page, url) {
  const tracePath = path.join(os.tmpdir(), `xenon-boot-trace-${process.pid}.json`);
  const urls = [];
  page.on('request', (request) => urls.push(request.url()));
  await browser.startTracing(page, { path: tracePath, categories: CATEGORIES });
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(CALLS_WINDOW_MS);
  await browser.stopTracing();
  const { traceEvents } = JSON.parse(readFileSync(tracePath, 'utf8'));
  rmSync(tracePath, { force: true });
  return { events: traceEvents, urls };
}

async function main() {
  const [port, windowArg] = process.argv.slice(2);
  if (!port) {
    console.error('usage: node tools/perf/boot-trace.mjs <port> [windowMs]');
    process.exitCode = 1;
    return;
  }
  const windowMs = Number(windowArg) || DEFAULT_WINDOW_MS;
  await withDashboard(port, async ({ browser, page }) => {
    await page.waitForTimeout(WARM_UP_MS);
    const { events, urls } = await traceLoad(browser, page, page.url());
    const scripts = scriptCosts(events);
    console.log(`scripts: ${scripts.length}, ${scripts.reduce((sum, row) => sum + row.ms, 0).toFixed(0)} ms`);
    for (const row of scripts.slice(0, ROWS)) console.log(`${row.ms.toFixed(1).padStart(7)} ms  ${row.key}`);
    const { style, layout, lines } = forcedPasses(events, windowMs);
    console.log(`first ${windowMs} ms: style ${style.toFixed(0)} ms, layout ${layout.toFixed(0)} ms`);
    for (const row of lines.slice(0, ROWS)) console.log(`${row.ms.toFixed(1).padStart(7)} ms ${String(row.passes).padStart(3)} passes  ${row.key}`);
    const { all, repeated } = repeatedCalls(urls);
    console.log(`API calls in ${CALLS_WINDOW_MS / 1000} s: ${all}`);
    for (const [pathname, count] of repeated.slice(0, ROWS)) console.log(`${String(count).padStart(4)}x ${pathname}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
