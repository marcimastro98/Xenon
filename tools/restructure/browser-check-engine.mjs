// Which browser engine the page check opens the pages in (browser-page-check.mjs).
// Chromium is the engine of the Windows app and the default. WebKit is the family
// of the macOS and Linux apps and of every browser on an iPhone; the build opened
// here is the one Playwright ships for this PC, which is neither WKWebView nor
// WebKitGTK: it shows how the engine's script and style code takes the pages, not
// what those two apps do around it.
//
// Both engines are started so that nothing a page opens leaves this PC. Chromium is
// told to find no address but this PC's own number. WebKit has no such switch: it
// gets a proxy that is a dead end (a port opened here that answers nothing and
// closes), with 127.0.0.1 going around it, so a socket to anywhere else ends there
// and is written down.

import { createServer } from 'node:net';

export const ENGINES = ['chromium', 'webkit'];
// The browser finds no address but this PC's own number, so nothing a page opens (a socket too) leaves this PC.
const NO_OUTSIDE = '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1';
/** What each engine writes in the console for a request the check refused. */
export const REFUSED = /net::ERR_BLOCKED_BY_CLIENT|Blocked by Web Inspector/;

/**
 * @param {string | undefined} asked what `--engine` or XENON_PAGE_ENGINE says, nothing for the default
 * @returns {string} one of ENGINES. Throws on any other word, so that a typo never records Chromium under another name.
 */
export function engineName(asked) {
  const name = String(asked ?? '').trim().toLowerCase() || ENGINES[0];
  if (!ENGINES.includes(name)) throw new Error(`"${asked}" is not an engine the page check knows: ${ENGINES.join(' or ')}`);
  return name;
}

/**
 * Takes `--engine <name>` out of a command line.
 * @param {string[]} argv @param {Record<string, string | undefined>} [env]
 * @returns {{ engine: string, rest: string[] }} the option wins over XENON_PAGE_ENGINE; `rest` is the line without it
 */
export function engineFromArgs(argv, env = process.env) {
  const at = argv.indexOf('--engine');
  if (at === -1) return { engine: engineName(env.XENON_PAGE_ENGINE), rest: [...argv] };
  if (argv[at + 1] === undefined) throw new Error(`--engine needs a name: ${ENGINES.join(' or ')}`);
  return { engine: engineName(argv[at + 1]), rest: [...argv.slice(0, at), ...argv.slice(at + 2)] };
}

/** @param {string} first what a client sent first @returns {string} where it wanted to go, as far as the lines say */
export function askedFor(first) {
  const lines = String(first).split('\r\n');
  const connect = /^CONNECT (\S+) /.exec(lines[0]);
  if (connect) return connect[1];
  const absolute = /^[A-Z]+ ([a-z]+:\/\/[^/\s]+)/.exec(lines[0]);
  if (absolute) return absolute[1];
  const host = lines.find((line) => /^host:/i.test(line));
  return host ? host.slice(5).trim() : lines[0].slice(0, 80);
}

/**
 * A port of this PC that takes a connection, keeps where it wanted to go and closes it.
 * @returns {Promise<{ port: number, asked: string[], close: () => Promise<void> }>}
 */
export async function deadEnd() {
  const asked = [];
  const server = createServer((socket) => {
    socket.on('error', () => { /* the browser gave up first */ });
    socket.once('data', (data) => {
      const where = askedFor(data.toString('latin1'));
      if (!asked.includes(where)) asked.push(where);
      socket.destroy();
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(undefined)); });
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { port, asked, close: () => new Promise((resolve) => { server.close(() => resolve()); }) };
}

/**
 * @param {string} engine @param {Record<string, string | undefined>} env @param {number} [deadEndPort] WebKit only
 * @returns {Record<string, any>} what the engine is started with: never shown, and blind to every other host
 */
export function launchOptions(engine, env, deadEndPort) {
  if (engine === 'webkit') return { headless: true, proxy: { server: `http://127.0.0.1:${deadEndPort}`, bypass: '127.0.0.1' } };
  return { headless: true, executablePath: env.CHROME_EXE || undefined, args: [NO_OUTSIDE] };
}

/**
 * Starts the engine. One browser, never shown.
 * @param {any} playwright @param {string} engine @param {Record<string, string | undefined>} [env]
 * @returns {Promise<{ browser: any, about: { name: string, version: string }, outside: string[], close: () => Promise<void> }>}
 *   `outside`: where the sockets of the pages wanted to go and did not (WebKit only; Chromium fails them before a connection)
 */
export async function startEngine(playwright, engine, env = process.env) {
  const end = engine === 'webkit' ? await deadEnd() : null;
  let browser;
  try {
    browser = await playwright[engine].launch(launchOptions(engine, env, end?.port));
  } catch (error) {
    if (end) await end.close();
    throw error;
  }
  const close = async () => { try { await browser.close(); } finally { if (end) await end.close(); } };
  return { browser, about: { name: engine, version: browser.version() }, outside: end ? end.asked : [], close };
}

/** @param {any} recording @returns {string} the engine a recording was made in (recordings older than this file are Chromium's) */
export const engineOf = (recording) => recording.engine?.name ?? ENGINES[0];

// What `now` has more often than `before`.
function extra(before, now) {
  const left = [...before];
  return now.filter((item) => { const at = left.indexOf(item); if (at === -1) return true; left.splice(at, 1); return false; });
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// The names on `window` that are not there on an empty page of either engine: only a script of the page can have made them.
const pageNames = (recording, view) => view.globals.filter((name) => !(recording.engine?.blank ?? []).includes(name));

/**
 * One tree recorded in two engines: what the second engine does with the pages that the first does not.
 * A fault is something a person on that engine would meet: an error, a request that failed, a module or a name
 * of a script that does not answer, a page's own question answered another way, Settings not keeping a value.
 * The rest is how engines differ and says nothing about the pages: the names the engine itself puts on
 * `window`, the way it writes a style rule back.
 * @param {any} first a recording, usually Chromium's @param {any} second the same tree in the other engine
 * @returns {{ faults: string[], differences: string[] }}
 */
export function engineDifferences(first, second) {
  const [one, two] = [engineOf(first), engineOf(second)];
  const faults = [];
  const differences = [];
  for (const was of first.views) if (!second.views.some((view) => view.name === was.name)) faults.push(`${was.name}: opened in ${one}, not in ${two}`);
  for (const now of second.views) {
    const was = first.views.find((view) => view.name === now.name);
    const fault = (text) => faults.push(`${now.name}: ${text}`);
    const differs = (text) => differences.push(`${now.name}: ${text}`);
    if (!was) { fault(`not opened in ${one}`); continue; }
    if (was.address !== now.address) fault(`ends on another address (${was.address} in ${one}, ${now.address} in ${two})`);
    for (const error of extra(was.pageErrors, now.pageErrors)) fault(`page error only in ${two}: ${error}`);
    for (const error of extra(now.pageErrors, was.pageErrors)) differs(`page error only in ${one}: ${error}`);
    for (const error of extra(was.consoleErrors, now.consoleErrors)) fault(`console error only in ${two}: ${error}`);
    for (const error of extra(now.consoleErrors, was.consoleErrors)) differs(`console error only in ${one}: ${error}`);
    for (const request of extra(was.failedRequests, now.failedRequests)) fault(`failed request only in ${two}: ${request}`);
    for (const request of extra(now.failedRequests, was.failedRequests)) differs(`failed request only in ${one}: ${request}`);
    for (const made of now.modules ?? []) {
      const old = (was.modules ?? []).find((entry) => entry.address === made.address);
      if (made.error) fault(`the module ${made.address} did not run: ${made.error}`);
      else if (!old) fault(`the module ${made.address} is loaded only in ${two}`);
      else if (old.exports && !same(old.exports, made.exports)) fault(`the module ${made.address} exports other names`);
    }
    for (const old of was.modules ?? []) if (!(now.modules ?? []).some((made) => made.address === old.address)) fault(`the module ${old.address} is not loaded in ${two}`);
    if (!same(was.scripts, now.scripts)) fault(`loads other scripts, or in another order (${was.scripts.length} in ${one}, ${now.scripts.length} in ${two})`);
    if (!same(was.stylesheets, now.stylesheets)) fault(`loads other stylesheets, or in another order (${was.stylesheets.length} in ${one}, ${now.stylesheets.length} in ${two})`);
    const names = [...new Set([...Object.keys(was.declared), ...Object.keys(now.declared)])];
    const changed = names.filter((name) => was.declared[name] !== now.declared[name]);
    if (changed.length) fault(`top-level names that answer differently: ${changed.map((name) => `${name} (${was.declared[name] ?? 'not there'} in ${one}, ${now.declared[name] ?? 'not there'} in ${two})`).join(', ')}`);
    if (!same(was.probe, now.probe)) fault(`the page's own question is answered differently (${JSON.stringify(was.probe)} in ${one}, ${JSON.stringify(now.probe)} in ${two})`);
    if (!same(was.asked, now.asked)) fault(`what the page was asked to load first ended differently (${JSON.stringify(was.asked)} in ${one}, ${JSON.stringify(now.asked)} in ${two})`);
    if (was.widgets !== now.widgets) fault(`the widgets on the page differ (${was.widgets} in ${one}, ${now.widgets} in ${two})`);
    // A name the engine has on an empty page is the engine's; any other one a script of the page put there.
    const [ownWas, ownNow] = [pageNames(first, was), pageNames(second, now)];
    const [gone, added] = [ownWas.filter((name) => !ownNow.includes(name)), ownNow.filter((name) => !ownWas.includes(name))];
    if (gone.length) fault(`names the page puts on window only in ${one}: ${gone.join(', ')}`);
    if (added.length) fault(`names the page puts on window only in ${two}: ${added.join(', ')}`);
    const builtIn = [was.globals.length - ownWas.length, now.globals.length - ownNow.length];
    if (builtIn[0] !== builtIn[1]) differs(`names of the engine itself on window: ${builtIn[0]} in ${one}, ${builtIn[1]} in ${two}`);
    if (was.rules !== now.rules) differs(`the style rules read back differ (${was.ruleCount} in ${one}, ${now.ruleCount} in ${two})`);
    for (const server of extra(was.refused ?? [], now.refused ?? [])) differs(`asks ${server} only in ${two} (refused)`);
    for (const server of extra(now.refused ?? [], was.refused ?? [])) differs(`asks ${server} only in ${one} (refused)`);
  }
  for (const [step, ok] of Object.entries(second.settings ?? {})) if (!ok) faults.push(`settings: "${step}" failed in ${two}`);
  return { faults, differences };
}
