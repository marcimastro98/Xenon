// The pages the page check opens (browser-page-check.mjs), and what it writes
// down about one of them. Every page the engine serves from a file of its own
// is here, and the page of the widgets on the desktop is opened with every
// built-in widget it can carry, a group at a time. A browser file may be split
// only when every page that loads it is on this list (browser-consumers.mjs).

import { createHash } from 'node:crypto';

import { liteWidgets } from './browser-lists.mjs';
import { readTopLevel } from './top-level.mjs';

const LOAD_TIMEOUT_MS = 60000;
// The page of desktop widgets holds at most 24 of them; a group stays under that.
const GROUP = 22;
const DESK = { width: 1280, height: 720 };

/**
 * `file` is the page's own file, `path` where the engine serves it. The dashboard is opened on the wide
 * screen it is made for and on a phone held upright. `widgets` marks the page the engine builds per
 * desktop widget. `stay` keeps a page that sends the window elsewhere once it has loaded (the driver
 * page leaves for the dashboard on an install that shows the dashboard) where it is.
 */
export const PAGES = [
  { name: 'dashboard wide', file: 'server/index.html', path: '/', width: 2560, height: 720 },
  { name: 'dashboard phone', file: 'server/index.html', path: '/', width: 390, height: 844 },
  { name: 'desktop widgets', file: 'server/layer-lite.html', path: '/?layer=desktop:', widgets: true, ...DESK },
  { name: 'deck window', file: 'server/deck-popup.html', path: '/deck-popup', ...DESK },
  { name: 'menu', file: 'server/menu.html', path: '/menu', ...DESK },
  { name: 'scene', file: 'server/scene.html', path: '/scene', ...DESK },
  { name: 'alerts', file: 'server/screen-alerts.html', path: '/screen-alerts', ...DESK },
  { name: 'search window', file: 'server/spotlight.html', path: '/spotlight', ...DESK },
  { name: 'drawing sheet', file: 'server/draw.html', path: '/draw', ...DESK },
  { name: 'widgets-only driver', file: 'server/shell-driver.html', path: '/shell-driver', stay: true, ...DESK },
  { name: 'widget service', file: 'server/sdk-service.html', path: '/sdk-service', ...DESK },
];

/** @param {string[]} pages repo-relative pages that load a file @returns {string[]} the ones the page check never opens */
export function uncheckedPages(pages) {
  const opened = new Set(PAGES.map((page) => page.file));
  return pages.filter((page) => !opened.has(page));
}

// An address without what changes from run to run: the port and the cache stamp.
export const plain = (text) => String(text).replace(/https?:\/\/127\.0\.0\.1:\d+/g, '').replace(/\?v=[\w.%-]+/g, '');

// What the page holds once it has loaded. Runs in the page.
function readPage() {
  const rules = [];
  const sheets = [];
  for (const sheet of document.styleSheets) {
    if (!sheet.href) continue;
    sheets.push(sheet.href);
    try { for (const rule of sheet.cssRules) rules.push(rule.cssText); } catch { rules.push(`unreadable ${sheet.href}`); }
  }
  return {
    address: window.location.pathname + window.location.search,
    globals: Object.getOwnPropertyNames(window).filter((name) => !/^\d+$/.test(name)).sort(),
    scripts: [...document.scripts].map((script) => script.src).filter(Boolean),
    sheets,
    rules,
    widgets: document.documentElement.getAttribute('data-layer-tiles'),
  };
}

// `typeof` of each name, asked as page code so that `const` and `let` answer too.
const typesOf = (names) => `[${names.map((name) => `(() => { try { return typeof ${name}; } catch (e) { return 'missing'; } })()`).join(',')}]`;

/**
 * Every name the page's own scripts declare at their top level, read from the scripts as the engine serves them.
 * @param {string[]} scripts addresses, in load order @param {any} parser @param {Map<string, string[]>} known names per script text, kept between pages
 * @returns {Promise<string[]>}
 */
async function declaredNames(scripts, parser, known) {
  const names = new Set();
  for (const address of scripts) {
    if (!/^https?:\/\/127\.0\.0\.1:\d+\/(?:js|shared)\//.test(address) || /\/vendor\//.test(address)) continue;
    const answer = await fetch(address);
    if (!answer.ok) continue;
    const text = await answer.text();
    if (!known.has(text)) {
      let found = [];
      try { found = readTopLevel(parser.parse(text, 'script.js'), parser).flatMap((record) => record.names); } catch { /* a script the parser cannot read declares nothing we can ask for */ }
      known.set(text, found.filter((name) => /^[A-Za-z_$][\w$]*$/.test(name)));
    }
    for (const name of known.get(text)) names.add(name);
  }
  return [...names].sort();
}

/**
 * Opens one address in a window of its own and hands the page to `run`. One window at a time, closed whatever happens.
 * @param {any} browser @param {number} port @param {{ path: string, width: number, height: number, stay?: boolean }} page @param {number} settleMs
 * @param {(page: any, seen: { pageErrors: string[], consoleErrors: string[], failedRequests: string[] }) => Promise<any>} run
 */
export async function openPage(browser, port, page, settleMs, run) {
  const context = await browser.newContext({ viewport: { width: page.width, height: page.height }, serviceWorkers: 'block' });
  try {
    const tab = await context.newPage();
    const first = `http://127.0.0.1:${port}${page.path}`;
    if (page.stay) {
      await tab.route('**/*', (route) => (route.request().isNavigationRequest() && route.request().frame() === tab.mainFrame() && route.request().url() !== first
        ? route.fulfill({ status: 204 }) : route.continue()));
    }
    const seen = { pageErrors: [], consoleErrors: [], failedRequests: [] };
    tab.on('pageerror', (error) => seen.pageErrors.push(plain(error.message)));
    tab.on('console', (message) => { if (message.type() === 'error') seen.consoleErrors.push(plain(message.text())); });
    tab.on('requestfailed', (request) => seen.failedRequests.push(`${plain(request.url())} ${request.failure()?.errorText ?? ''}`.trim()));
    tab.on('response', (response) => { if (response.status() >= 400) seen.failedRequests.push(`${plain(response.url())} ${response.status()}`); });
    await tab.goto(first, { waitUntil: 'load', timeout: LOAD_TIMEOUT_MS });
    await tab.waitForTimeout(settleMs);
    return await run(tab, seen);
  } finally {
    await context.close();
  }
}

/**
 * @param {any} browser @param {number} port @param {{ name: string, path: string, width: number, height: number, stay?: boolean }} page
 * @param {number} settleMs @param {any} parser @param {Map<string, string[]>} known
 * @returns {Promise<any>} what the page check keeps of one page
 */
export function recordPage(browser, port, page, settleMs, parser, known) {
  return openPage(browser, port, page, settleMs, async (tab, seen) => {
    const held = await tab.evaluate(readPage);
    const names = await declaredNames(held.scripts, parser, known);
    const types = names.length ? await tab.evaluate(typesOf(names)) : [];
    return {
      name: page.name, path: page.path, address: held.address, width: page.width, height: page.height, ...seen,
      globals: held.globals,
      scripts: held.scripts.map(plain), stylesheets: held.sheets.map(plain),
      rules: createHash('sha256').update(held.rules.join('\n')).digest('hex'), ruleCount: held.rules.length,
      declared: Object.fromEntries(names.map((name, i) => [name, types[i]])),
      ...(held.widgets === null ? {} : { widgets: held.widgets }),
    };
  });
}

// One call to the test copy, the way its own pages make it.
async function ask(port, path, body) {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return answer.json();
}

/**
 * The page of the widgets on the desktop, once per group of built-in widgets it can carry, so that every
 * script and stylesheet a widget brings is loaded by a real page. The widgets are placed and taken away
 * through the app's own actions; the test copy is first told a window can draw them, as the app's window does.
 * @returns {Promise<any[]>} one record per group
 */
export async function recordWidgetPages(browser, port, page, settleMs, parser, known) {
  const widgets = liteWidgets(await (await fetch(`http://127.0.0.1:${port}/js/layer-tiles.js`)).text());
  const host = await ask(port, '/layers/host', { layers: true, monitors: [] });
  if (host?.layers !== true) throw new Error(`the test copy did not take the report that widgets can be drawn: ${JSON.stringify(host)}`);
  const records = [];
  for (let at = 0; at < widgets.length; at += GROUP) {
    const group = widgets.slice(at, at + GROUP);
    const placed = [];
    try {
      for (const widget of group) {
        const done = await ask(port, '/actions/run', { type: 'layerPlace', widget, surface: 'desktop', position: 'top-right', size: 'medium' });
        if (done?.ok !== true) throw new Error(`the widget "${widget}" could not be put on the desktop: ${JSON.stringify(done)}`);
        placed.push(done.placed.id);
      }
      const record = await recordPage(browser, port, { ...page, name: `${page.name} ${at / GROUP + 1}` }, settleMs, parser, known);
      if (record.widgets !== [...group].sort().join(' ')) {
        throw new Error(`${record.name}: the engine answered with ${record.widgets === undefined ? 'the whole dashboard' : `the widgets "${record.widgets}"`}, not the page of ${group.join(' ')}`);
      }
      records.push(record);
    } finally {
      for (const id of placed) await ask(port, '/actions/run', { type: 'layerRemove', target: id });
    }
  }
  return records;
}
