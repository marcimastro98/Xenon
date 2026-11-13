// Loads the dashboard in a real headless browser and writes down what a split of
// the browser files could break: errors while the page loads, the names the page
// puts on `window`, every moved name still answering, the style rules the page
// ends up with, and Settings opening, changing one setting and keeping it.
// Run it on the commit before the split and on the split, then compare the two.
//
//   node tools/restructure/browser-page-check.mjs record <port> <out.json> [settleMs]
//   node tools/restructure/browser-page-check.mjs compare <before.json> <after.json>
//
// Point it at a test copy of the server with data of its own, never at the one in
// daily use (it refuses port 3030): the check changes the clock format and puts it
// back. Playwright is not a dependency of this repo: it is borrowed from the
// sibling xenon-maker checkout, or from the folder XENON_PLAYWRIGHT names.
// CHROME_EXE picks the browser. One browser, one window at a time.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readBrowserLedger } from './browser-ledger.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DAILY_PORT = 3030;
const LOAD_TIMEOUT_MS = 60000;
const SAVE_WAIT_MS = 2500;
// The wide screen the dashboard is made for, and a phone held upright.
const VIEWS = [{ name: 'wide', width: 2560, height: 720 }, { name: 'phone', width: 390, height: 844 }];

function loadPlaywright() {
  const from = process.env.XENON_PLAYWRIGHT || path.resolve(REPO_ROOT, '..', 'xenon-maker', 'node_modules', 'playwright');
  return createRequire(import.meta.url)(from);
}

// An address without what changes from run to run: the port and the cache stamp.
const plain = (text) => String(text).replace(/https?:\/\/127\.0\.0\.1:\d+/g, '').replace(/\?v=[\w.-]+/g, '');

/** @returns {string[]} every top-level name the recorded moves took out of a script */
export function movedNames(root = REPO_ROOT) {
  return readBrowserLedger(root).moves.filter((move) => move.kind === 'script').flatMap((move) => move.names);
}

// What the page holds once it has loaded. Runs in the page.
function readPage() {
  const rules = [];
  let linked = 0;
  for (const sheet of document.styleSheets) {
    if (!sheet.href) continue;
    linked += 1;
    try { for (const rule of sheet.cssRules) rules.push(rule.cssText); } catch { rules.push(`unreadable ${sheet.href}`); }
  }
  return {
    globals: Object.getOwnPropertyNames(window).filter((name) => !/^\d+$/.test(name)).sort(),
    scripts: document.scripts.length,
    stylesheets: linked,
    rules,
  };
}

// `typeof` of each name, asked as page code so that `const` and `let` answer too.
const typesOf = (names) => `[${names.map((name) => `(() => { try { return typeof ${name}; } catch (e) { return 'missing'; } })()`).join(',')}]`;

async function openView(browser, port, view, settleMs, run) {
  const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const seen = { pageErrors: [], consoleErrors: [], failedRequests: [] };
    page.on('pageerror', (error) => seen.pageErrors.push(plain(error.message)));
    page.on('console', (message) => { if (message.type() === 'error') seen.consoleErrors.push(plain(message.text())); });
    page.on('requestfailed', (request) => seen.failedRequests.push(`${plain(request.url())} ${request.failure()?.errorText ?? ''}`.trim()));
    page.on('response', (response) => { if (response.status() >= 400) seen.failedRequests.push(`${plain(response.url())} ${response.status()}`); });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: LOAD_TIMEOUT_MS });
    await page.waitForTimeout(settleMs);
    return await run(page, seen);
  } finally {
    await context.close();
  }
}

const clockFormat = (page) => page.evaluate('hubSettings.clockFormat');
const pickClockFormat = (page, value) => page.evaluate((format) => {
  const button = document.querySelector(`.settings-clock-format[data-clock-format="${format}"]`);
  button.click();
  return button.getAttribute('aria-pressed') === 'true';
}, value);

// Settings opens, the clock format changes through its own button, and the new value
// is still there after a reload and in a window that never saw it (so it came from the server).
async function settingsRoundTrip(browser, port, settleMs) {
  const result = { opened: false, changed: false, afterReload: false, fromServer: false };
  const first = await openView(browser, port, VIEWS[0], settleMs, async (page) => {
    const was = await clockFormat(page);
    const next = was === '12' ? '24' : '12';
    result.opened = await page.evaluate(() => {
      openSettings();
      const overlay = document.getElementById('settings-overlay');
      return Boolean(overlay && !overlay.hidden && overlay.getBoundingClientRect().width > 0);
    });
    const pressed = await pickClockFormat(page, next);
    result.changed = pressed && (await clockFormat(page)) === next;
    await page.waitForTimeout(SAVE_WAIT_MS);
    await page.reload({ waitUntil: 'load', timeout: LOAD_TIMEOUT_MS });
    await page.waitForTimeout(settleMs);
    result.afterReload = (await clockFormat(page)) === next;
    return { was, next };
  });
  await openView(browser, port, VIEWS[0], settleMs, async (page) => {
    result.fromServer = (await clockFormat(page)) === first.next;
    await pickClockFormat(page, first.was);
    await page.waitForTimeout(SAVE_WAIT_MS);
  });
  return result;
}

async function record(port, outFile, settleMs) {
  if (port === DAILY_PORT) throw new Error(`port ${DAILY_PORT} is the server in daily use: start a test copy on another port`);
  const names = movedNames();
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXE || undefined });
  const views = [];
  let settings;
  try {
    for (const view of VIEWS) {
      views.push(await openView(browser, port, view, settleMs, async (page, seen) => {
        const held = await page.evaluate(readPage);
        const types = names.length ? await page.evaluate(typesOf(names)) : [];
        const rules = createHash('sha256').update(held.rules.join('\n')).digest('hex');
        return { ...view, ...seen, ...held, rules, ruleCount: held.rules.length, moved: Object.fromEntries(names.map((name, i) => [name, types[i]])) };
      }));
    }
    settings = await settingsRoundTrip(browser, port, settleMs);
  } finally {
    await browser.close();
  }
  writeFileSync(outFile, `${JSON.stringify({ views, settings }, null, 1)}\n`);
  for (const view of views) {
    console.log(`${view.name}: ${view.pageErrors.length} page errors, ${view.consoleErrors.length} console errors, ${view.failedRequests.length} failed requests, `
      + `${view.globals.length} names on window, ${view.scripts} scripts, ${view.stylesheets} stylesheets, ${view.ruleCount} style rules.`);
  }
  console.log(`settings: ${JSON.stringify(settings)}`);
}

// What `now` has more often than `before`.
function extra(before, now) {
  const left = [...before];
  return now.filter((item) => { const at = left.indexOf(item); if (at === -1) return true; left.splice(at, 1); return false; });
}

/**
 * @param {any} before a recording made on the commit before the split @param {any} after a recording made on the split
 * @returns {string[]} what the split changed in the page, empty when nothing
 */
export function compareRecordings(before, after) {
  const problems = [];
  for (const now of after.views) {
    const was = before.views.find((view) => view.name === now.name);
    const say = (text) => problems.push(`${now.name}: ${text}`);
    if (!was) { say('not recorded before'); continue; }
    for (const error of now.pageErrors) say(`page error: ${error}`);
    for (const error of extra(was.consoleErrors, now.consoleErrors)) say(`new console error: ${error}`);
    for (const request of extra(was.failedRequests, now.failedRequests)) say(`new failed request: ${request}`);
    const gone = was.globals.filter((name) => !now.globals.includes(name));
    const added = now.globals.filter((name) => !was.globals.includes(name));
    if (gone.length) say(`no longer on window: ${gone.join(', ')}`);
    if (added.length) say(`new on window: ${added.join(', ')}`);
    const changed = Object.keys(now.moved).filter((name) => now.moved[name] !== was.moved[name] || now.moved[name] === 'missing');
    if (changed.length) say(`moved names that answer differently: ${changed.map((name) => `${name} (${was.moved[name]} -> ${now.moved[name]})`).join(', ')}`);
    if (was.rules !== now.rules) say(`the style rules of the linked stylesheets differ (${was.ruleCount} before, ${now.ruleCount} now)`);
  }
  for (const [step, ok] of Object.entries(after.settings)) if (!ok) problems.push(`settings: "${step}" failed`);
  return problems;
}

function compare(beforeFile, afterFile) {
  const [before, after] = [beforeFile, afterFile].map((file) => JSON.parse(readFileSync(file, 'utf8')));
  const problems = compareRecordings(before, after);
  if (problems.length) { console.error(problems.join('\n')); return 1; }
  for (const view of after.views) {
    const was = before.views.find((entry) => entry.name === view.name);
    console.log(`${view.name}: same as before. 0 page errors, ${view.consoleErrors.length} console errors (${was.consoleErrors.length} before), `
      + `${view.globals.length} names on window, ${Object.keys(view.moved).length} moved names answer, ${view.ruleCount} style rules, `
      + `${view.scripts} scripts (${was.scripts} before), ${view.stylesheets} stylesheets (${was.stylesheets} before).`);
  }
  console.log('settings: opens, the clock format changes, survives a reload and comes back from the server.');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, a, b, c] = process.argv.slice(2);
  if (command === 'record' && Number(a) > 0 && b) await record(Number(a), b, Number(c) || 5000);
  else if (command === 'compare' && a && b) process.exitCode = compare(a, b);
  else {
    console.error(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(6, 8).map((line) => line.replace(/^\/\/ ?/, '')).join('\n'));
    process.exitCode = 2;
  }
}
