// The pages the page check opens (browser-page-check.mjs), and what it writes
// down about one of them. Every page the engine serves from a file of its own
// is here, and the page of the widgets on the desktop is opened with every
// built-in widget it can carry, a group at a time. A browser file may be split
// only when every page that loads it is on this list (browser-consumers.mjs).

import { createHash } from 'node:crypto';

import { REFUSED } from './browser-check-engine.mjs';
import { liteWidgets } from './browser-lists.mjs';
import { readTopLevel } from './top-level.mjs';

const LOAD_TIMEOUT_MS = 60000;
// The page of desktop widgets holds at most 24 of them; a group stays under that.
const GROUP = 22;
const DESK = { width: 1280, height: 720 };

// What the window of a second deck shows: whose deck the tile is, and that it was drawn. The page's last script
// (js/deck-popup.js) writes the first from the address before the deck starts. Runs in the page.
function deckOfTheWindow() {
  const tile = document.querySelector('[data-dashboard-widget="deck"]');
  return { deck: tile ? tile.getAttribute('data-dashboard-instance') : 'no tile', drawn: Boolean(tile?.childElementCount) };
}

// The voice panel of the screen: the alerts window loads its scripts only when Bit is called (js/screen-bit.js holds
// the list). Called here, so that the page is read with them in it. Runs in the page.
function callBit() {
  return window.ScreenBit.load().then(() => 'loaded', (error) => `not loaded: ${error?.message || error}`);
}

// What the search of Settings would offer on this page: every row, button and section it finds, with the name it
// gives each, the place it puts it under and how many words it can be found by. The page's own function is asked
// (js/settings-search.js hands it out as `_build`); it reads the page and changes nothing. Runs in the page.
function settingsSearchRows() {
  const build = window.SettingsSearch?._build;
  if (typeof build !== 'function') return 'no settings search';
  const kinds = {};
  let sum = 0;
  for (const entry of build()) {
    kinds[entry.kind] = (kinds[entry.kind] || 0) + 1;
    const line = [entry.id, entry.kind, entry.labelKey, entry.hintKey || '', entry.cardKey || '', entry.catKey || '', entry.fields.length].join('|');
    for (const letter of line) sum = (Math.imul(sum, 31) + letter.codePointAt(0)) >>> 0;
  }
  return { kinds, sum };
}

/**
 * `file` is the page's own file, `path` where the engine serves it. The dashboard is opened on the wide
 * screen it is made for and on a phone held upright. `widgets` marks the page the engine builds per
 * desktop widget. `stay` keeps a page that sends the window elsewhere once it has loaded (the driver
 * page leaves for the dashboard on an install that shows the dashboard) where it is. `probe` is a question of the
 * page's own, asked in the page once it has loaded: what a module does cannot be asked by name from outside.
 * `first` is something the page is asked to do before it is read, for the files it loads only when asked; `holds`
 * names the script whose list those files are in (browser-lists.mjs).
 */
export const PAGES = [
  { name: 'dashboard wide', file: 'server/index.html', path: '/', probe: settingsSearchRows, width: 2560, height: 720 },
  { name: 'dashboard phone', file: 'server/index.html', path: '/', probe: settingsSearchRows, width: 390, height: 844 },
  { name: 'desktop widgets', file: 'server/layer-lite.html', path: '/?layer=desktop:', widgets: true, ...DESK },
  { name: 'deck window', file: 'server/deck-popup.html', path: '/deck-popup', ...DESK },
  { name: 'deck window of a second deck', file: 'server/deck-popup.html', path: '/deck-popup?instance=deck~two', probe: deckOfTheWindow, ...DESK },
  { name: 'menu', file: 'server/menu.html', path: '/menu', ...DESK },
  { name: 'scene', file: 'server/scene.html', path: '/scene', ...DESK },
  { name: 'alerts', file: 'server/screen-alerts.html', path: '/screen-alerts', ...DESK },
  { name: 'alerts with the voice panel', file: 'server/screen-alerts.html', path: '/screen-alerts', first: callBit, holds: 'server/js/screen-bit.js', ...DESK },
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

/**
 * Whether a request of a page stays on the test copy. A page of the app can name another address in its code
 * (the native bridge called the fixed address of the installed app until it followed the page), and the check must never reach that one,
 * nor any site outside this PC: only the copy answers, and what is made in the page itself (data, blob, about).
 * @param {string} address @param {number} port @returns {boolean}
 */
export function staysOnCopy(address, port) {
  let url;
  try { url = new URL(address); } catch { return false; }
  if (['data:', 'blob:', 'about:'].includes(url.protocol)) return true;
  return ['http:', 'ws:'].includes(url.protocol) && url.hostname === '127.0.0.1' && url.port === String(port);
}

// Where a refused request was going: the server, without the path (a news picture has a new one every hour).
export function serverOf(address) {
  try { const url = new URL(address); return `${url.protocol}//${url.host}`; } catch { return String(address); }
}

/** @param {string} server as serverOf gives it @returns {boolean} whether it is a server of this PC (the installed app is one) */
export function onThisPc(server) {
  try { return /^(?:localhost|127(?:\.\d+){3}|\[::1\])$/.test(new URL(server).hostname); } catch { return false; }
}

/**
 * An address without what changes from run to run: the copy's own port and the cache stamp. Any other address
 * keeps its host and port, so a request the check refused is written down with where it was going.
 * @param {number} port @returns {(text: string) => string}
 */
export function plainFor(port) {
  const own = `http://127.0.0.1:${port}`;
  return (text) => String(text).replaceAll(own, '').replace(/\?v=[\w.%-]+/g, '');
}

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
    modules: [...document.scripts].filter((script) => script.type === 'module' && script.src).map((script) => script.src),
    sheets,
    rules,
    widgets: document.documentElement.getAttribute('data-layer-tiles'),
  };
}

// Asks the page for each of its modules again, by the address of its tag: the browser hands back the module the
// tag made, without running it a second time. It answers once the module ran to its end, and fails with the
// module's own error when it did not. A module's top-level names cannot be asked from outside: this, and the
// names it exports, is what the check knows of it. Runs in the page.
function importAll(addresses) {
  return Promise.all(addresses.map((address) => import(address).then(
    (made) => ({ address, exports: Object.keys(made).sort() }),
    (error) => ({ address, error: String(error?.message || error) }),
  )));
}

// `typeof` of each name, asked as page code so that `const` and `let` answer too.
const typesOf = (names) => `[${names.map((name) => `(() => { try { return typeof ${name}; } catch (e) { return 'missing'; } })()`).join(',')}]`;

/**
 * Every name the page's own classic scripts declare at their top level, read from the scripts as the engine serves them.
 * @param {string[]} scripts addresses, in load order, without the modules (their names are their own) @param {any} parser @param {Map<string, string[]>} known names per script text, kept between pages
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
 * Every request of the window that would leave the test copy is refused before it is sent, and the server it
 * was going to is kept in `refused`. A socket is not a request: the page check starts the browser so that it
 * finds no site outside this PC (browser-page-check.mjs), and no page of the app opens a socket to another port.
 * @param {any} browser @param {number} port @param {{ path: string, width: number, height: number, stay?: boolean }} page @param {number} settleMs
 * @param {(page: any, seen: { pageErrors: string[], consoleErrors: string[], failedRequests: string[], refused: string[] }) => Promise<any>} run
 */
export async function openPage(browser, port, page, settleMs, run) {
  const context = await browser.newContext({ viewport: { width: page.width, height: page.height }, serviceWorkers: 'block' });
  try {
    const tab = await context.newPage();
    const first = `http://127.0.0.1:${port}${page.path}`;
    const plain = plainFor(port);
    const seen = { pageErrors: [], consoleErrors: [], failedRequests: [], refused: [] };
    // The way out of a page that must stay, which the check itself answers with nothing: WebKit calls that a failed request.
    const held = new Set();
    await context.route('**/*', (route) => {
      const request = route.request();
      if (!staysOnCopy(request.url(), port)) {
        const server = serverOf(request.url());
        if (!seen.refused.includes(server)) seen.refused.push(server);
        return route.abort('blockedbyclient');
      }
      const leaves = page.stay && request.isNavigationRequest() && request.frame() === tab.mainFrame() && request.url() !== first;
      if (leaves) held.add(request);
      return leaves ? route.fulfill({ status: 204 }) : route.continue();
    });
    tab.on('pageerror', (error) => seen.pageErrors.push(plain(error.message)));
    tab.on('console', (message) => { if (message.type() === 'error' && !REFUSED.test(message.text())) seen.consoleErrors.push(plain(message.text())); });
    tab.on('requestfailed', (request) => { if (staysOnCopy(request.url(), port) && !held.has(request)) seen.failedRequests.push(`${plain(request.url())} ${request.failure()?.errorText ?? ''}`.trim()); });
    tab.on('response', (response) => { if (response.status() >= 400) seen.failedRequests.push(`${plain(response.url())} ${response.status()}`); });
    await tab.goto(first, { waitUntil: 'load', timeout: LOAD_TIMEOUT_MS });
    await tab.waitForTimeout(settleMs);
    return await run(tab, seen);
  } finally {
    await context.close();
  }
}

/**
 * @param {any} browser @param {number} port @param {{ name: string, path: string, width: number, height: number, stay?: boolean, probe?: () => any, first?: () => any }} page
 * @param {number} settleMs @param {any} parser @param {Map<string, string[]>} known
 * @returns {Promise<any>} what the page check keeps of one page
 */
export function recordPage(browser, port, page, settleMs, parser, known) {
  const plain = plainFor(port);
  return openPage(browser, port, page, settleMs, async (tab, seen) => {
    const asked = page.first ? await tab.evaluate(page.first) : null;
    if (page.first) await tab.waitForTimeout(settleMs);
    const held = await tab.evaluate(readPage);
    const names = await declaredNames(held.scripts.filter((address) => !held.modules.includes(address)), parser, known);
    const modules = held.modules.length ? await tab.evaluate(importAll, held.modules) : [];
    const types = names.length ? await tab.evaluate(typesOf(names)) : [];
    return {
      name: page.name, path: page.path, address: held.address, width: page.width, height: page.height, ...seen, refused: [...seen.refused].sort(),
      globals: held.globals,
      scripts: held.scripts.map(plain), stylesheets: held.sheets.map(plain),
      rules: createHash('sha256').update(held.rules.join('\n')).digest('hex'), ruleCount: held.rules.length,
      declared: Object.fromEntries(names.map((name, i) => [name, types[i]])),
      ...(modules.length ? { modules: modules.map((made) => (made.error ? { address: plain(made.address), error: plain(made.error) } : { ...made, address: plain(made.address) })) } : {}),
      ...(held.widgets === null ? {} : { widgets: held.widgets }),
      ...(page.first ? { asked } : {}),
      ...(page.probe ? { probe: await tab.evaluate(page.probe) } : {}),
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
