// Loads every page of the app in a real headless browser and writes down, page by
// page, what a split of the browser files could break: errors while the page
// loads, the files it loads and in which order, the names it puts on `window`,
// every top-level name of its classic scripts still answering, every module having
// run to its end, the style rules it ends up with; and, on the dashboard, Settings opening, changing one setting and keeping it.
//
//   node tools/restructure/browser-page-check.mjs record <port> <out.json> [settleMs]
//   node tools/restructure/browser-page-check.mjs compare <before.json> <after.json>
//
// Run `record` on the commit before the split and on the split, then `compare`.
// The pages are listed in browser-check-pages.mjs. It only opens a copy made and
// started by side-copy.mjs (the copy answers a marker file; port 3030 and any other
// server are refused): the check changes the clock format and the widgets on the
// desktop, and puts both back. Playwright is not a dependency of this repo: it is borrowed from
// the sibling xenon-maker checkout, or from the folder XENON_PLAYWRIGHT names.
// CHROME_EXE picks the browser. One browser, one window at a time, never shown.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAGES, onThisPc, openPage, recordPage, recordWidgetPages } from './browser-check-pages.mjs';
import { readBrowserLedger, runOf, splitFiles } from './browser-ledger.mjs';
import { openParser } from './parser.mjs';
import { mustBeSideCopy } from './side-copy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DAILY_PORT = 3030;
const LOAD_TIMEOUT_MS = 60000;
const SAVE_WAIT_MS = 2500;
const LISTS = ['scripts', 'stylesheets'];
// The browser finds no address but this PC's own number, so nothing a page opens (a socket too) leaves this PC.
const NO_OUTSIDE = '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1';

function loadPlaywright() {
  const from = process.env.XENON_PLAYWRIGHT || path.resolve(REPO_ROOT, '..', 'xenon-maker', 'node_modules', 'playwright');
  return createRequire(import.meta.url)(from);
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
  const first = await openPage(browser, port, PAGES[0], settleMs, async (page) => {
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
  await openPage(browser, port, PAGES[0], settleMs, async (page) => {
    result.fromServer = (await clockFormat(page)) === first.next;
    await pickClockFormat(page, first.was);
    await page.waitForTimeout(SAVE_WAIT_MS);
  });
  return result;
}

const sayPage = (view) => `${view.name} (${view.address}): ${view.pageErrors.length} page errors, ${view.consoleErrors.length} console errors, `
  + `${view.failedRequests.length} failed requests, ${view.refused.length} servers outside the copy refused, ${view.globals.length} names on window, ${Object.keys(view.declared).length} top-level names, `
  + `${view.scripts.length} scripts${view.modules ? ` (${view.modules.length} modules)` : ''}, ${view.stylesheets.length} stylesheets, ${view.ruleCount} style rules.`;

async function record(port, outFile, settleMs) {
  if (port === DAILY_PORT) throw new Error(`port ${DAILY_PORT} is the server in daily use: start a test copy on another port`);
  await mustBeSideCopy(port);
  const { chromium } = loadPlaywright();
  const parser = await openParser();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXE || undefined, args: [NO_OUTSIDE] });
  const known = new Map();
  const views = [];
  let settings;
  try {
    for (const page of PAGES) {
      const made = page.widgets ? await recordWidgetPages(browser, port, page, settleMs, parser, known)
        : [await recordPage(browser, port, page, settleMs, parser, known)];
      for (const view of made) { views.push(view); console.log(sayPage(view)); }
    }
    settings = await settingsRoundTrip(browser, port, settleMs);
  } finally {
    await browser.close();
    parser.close();
  }
  writeFileSync(outFile, `${JSON.stringify({ views, settings }, null, 1)}\n`);
  console.log(`settings: ${JSON.stringify(settings)}`);
}

// What `now` has more often than `before`.
function extra(before, now) {
  const left = [...before];
  return now.filter((item) => { const at = left.indexOf(item); if (at === -1) return true; left.splice(at, 1); return false; });
}

const addressOf = (file) => `/${file.slice('server/'.length)}`;
const madeBy = (move) => (move.kind === 'style' ? move.parts.map((part) => part.file) : [move.file]);

// The files a page loads, against the ones it loaded before: the same once the files a split made are left out,
// and every split file followed (or led) by all its parts with nothing between.
function loadProblems(was, now, ledger, what) {
  const problems = [];
  const made = new Set(ledger.moves.filter((move) => move.kind === 'script' || move.kind === 'style').flatMap(madeBy).map(addressOf));
  const [old, cur] = [was, now].map((list) => list.filter((address) => !made.has(address)));
  if (old.join('\n') !== cur.join('\n')) {
    const [gone, added] = [extra(cur, old), extra(old, cur)];
    problems.push(gone.length || added.length
      ? `the ${what} it loads changed:${gone.length ? ` no longer ${gone.join(', ')}` : ''}${added.length ? ` new ${added.join(', ')}` : ''}`
      : `it loads the same ${what} in another order`);
  }
  for (const file of splitFiles(ledger)) {
    const run = runOf(ledger, file).map(addressOf);
    const first = now.findIndex((address) => run.includes(address));
    if (first !== -1 && now.slice(first, first + run.length).join('\n') !== run.join('\n')) {
      problems.push(`${addressOf(file)} and its parts do not load in a row: ${now.filter((address) => run.includes(address)).join(', ')}`);
    }
  }
  return problems;
}

// The modules of a page against the ones it had. A module's top-level names are its own, so the check cannot ask
// for them: it holds that each module ran to its end and exports the names it exported. A script that is a module
// now and was not before must be a recorded conversion, and only the names recorded for it may leave the page.
function moduleProblems(was, now, ledger) {
  const problems = [];
  const hidden = new Set();
  const before = new Map((was.modules ?? []).map((made) => [made.address, made]));
  const recorded = new Map(ledger.moves.filter((move) => move.kind === 'module').map((move) => [addressOf(move.file), move.names]));
  const list = (names) => names.join(', ') || 'none';
  for (const made of now.modules ?? []) {
    if (made.error) problems.push(`the module ${made.address} did not run: ${made.error}`);
    const old = before.get(made.address);
    if (!old && !recorded.has(made.address)) problems.push(`loads ${made.address} as a module, and no recorded move made it one`);
    else if (!old) for (const name of recorded.get(made.address)) hidden.add(name);
    else if (old.exports && made.exports && old.exports.join(' ') !== made.exports.join(' ')) problems.push(`the module ${made.address} exports other names (${list(old.exports)} before, ${list(made.exports)} now)`);
  }
  for (const address of before.keys()) if (!(now.modules ?? []).some((made) => made.address === address)) problems.push(`no longer loads the module ${address}`);
  return { problems, hidden };
}

/**
 * @param {any} before a recording made on the commit before the split @param {any} after a recording made on the split
 * @param {{ moves: any[] }} [ledger] the recorded moves, to tell the files a split made from any other new file
 * @returns {string[]} what the split changed in the pages, empty when nothing
 */
export function compareRecordings(before, after, ledger = readBrowserLedger(REPO_ROOT)) {
  const problems = [];
  for (const was of before.views) if (!after.views.some((view) => view.name === was.name)) problems.push(`${was.name}: opened before, not opened now`);
  for (const now of after.views) {
    const was = before.views.find((view) => view.name === now.name);
    const say = (text) => problems.push(`${now.name}: ${text}`);
    if (!was) { say('not recorded before'); continue; }
    if (was.address !== now.address) say(`ends on another address (${was.address} before, ${now.address} now)`);
    for (const error of extra(was.pageErrors, now.pageErrors)) say(`new page error: ${error}`);
    for (const error of extra(was.consoleErrors, now.consoleErrors)) say(`new console error: ${error}`);
    for (const request of extra(was.failedRequests, now.failedRequests)) say(`new failed request: ${request}`);
    // A site outside changes with the news of the day; a server of this PC a page asks is in its code.
    for (const server of extra(was.refused ?? [], now.refused ?? [])) if (onThisPc(server)) say(`asks another server of this PC, which the check refused: ${server}`);
    const modules = moduleProblems(was, now, ledger);
    const gone = was.globals.filter((name) => !now.globals.includes(name) && !modules.hidden.has(name));
    const added = now.globals.filter((name) => !was.globals.includes(name));
    if (gone.length) say(`no longer on window: ${gone.join(', ')}`);
    if (added.length) say(`new on window: ${added.join(', ')}`);
    const names = [...new Set([...Object.keys(was.declared), ...Object.keys(now.declared)])];
    const changed = names.filter((name) => (now.declared[name] !== was.declared[name] || now.declared[name] === 'missing') && !(modules.hidden.has(name) && !(name in now.declared)));
    if (changed.length) say(`top-level names that answer differently: ${changed.map((name) => `${name} (${was.declared[name] ?? 'not there'} -> ${now.declared[name] ?? 'not there'})`).join(', ')}`);
    for (const problem of modules.problems) say(problem);
    for (const what of LISTS) for (const problem of loadProblems(was[what], now[what], ledger, what)) say(problem);
    if (was.rules !== now.rules) say(`the style rules of the linked stylesheets differ (${was.ruleCount} before, ${now.ruleCount} now)`);
    if (was.widgets !== now.widgets) say(`the widgets on the page differ (${was.widgets} before, ${now.widgets} now)`);
    if (JSON.stringify(was.probe) !== JSON.stringify(now.probe)) say(`the page's own question is answered differently (${JSON.stringify(was.probe)} before, ${JSON.stringify(now.probe)} now)`);
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
    console.log(`${view.name}: same as before. ${view.pageErrors.length} page errors, ${view.consoleErrors.length} console errors (${was.consoleErrors.length} before), `
      + `${view.globals.length} names on window, ${Object.keys(view.declared).length} top-level names answer, ${view.ruleCount} style rules, `
      + `${view.scripts.length} scripts (${was.scripts.length} before), ${view.stylesheets.length} stylesheets (${was.stylesheets.length} before).`);
  }
  const ran = after.views.flatMap((view) => view.modules ?? []).length;
  console.log(`${after.views.length} pages${ran ? `, ${ran} module loads ran to their end` : ''}. settings: opens, the clock format changes, survives a reload and comes back from the server.`);
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
