import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(HERE, '..');
const read = (f) => fs.readFileSync(path.join(SERVER_DIR, f), 'utf8');

// A service worker fails SILENTLY and PERSISTENTLY: a wrong cache name serves a
// previous version of the app forever, a missing credentials flag makes the
// browser refuse to install with no error anywhere, and a user cannot undo
// either without DevTools. Everything asserted here is one of those.

test('the shell cache is stamped with the app version and swept on activate', () => {
  const sw = read('sw.js');
  const server = read('server.js');
  // The route substitutes this token. Rename it on one side only and the cache
  // name becomes a literal string: it never changes between versions, so an
  // updated Xenon keeps serving the previous shell out of cache — the one
  // failure a reload cannot clear.
  assert.match(sw, /__XENON_VERSION__/, 'sw.js must carry the substitution token');
  assert.match(server, /sw\.js[\s\S]{0,900}?replace\('__XENON_VERSION__', APP_VERSION\)/,
    'the /sw.js route must stamp the version in');
  // And the sweep that makes the stamp mean something.
  assert.match(sw, /caches\.delete/, 'old caches must be deleted');
  assert.match(sw, /n !== CACHE/, 'the sweep must keep the CURRENT cache and drop the rest');
});

test('the worker caches the shell and never anything that describes the PC', () => {
  const sw = read('sw.js');
  const never = /const NEVER = \[([\s\S]*?)\];/.exec(sw);
  assert.ok(never, 'the NEVER list must be findable');
  const listed = [...never[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  // A cached answer on any of these is a lie about the machine — a stale sensor
  // reading, a settings blob that no longer matches disk, an action that looks
  // to have run. They are the reason this worker is network-first everywhere.
  for (const p of ['/api/', '/sse', '/settings', '/actions/', '/sdk/', '/status', '/system', '/media', '/audio']) {
    assert.ok(listed.includes(p), p + ' must never be cached');
  }
  // Network first, always: the cache may only be reached from a catch block.
  assert.ok(!/caches\.match\([^)]*\)\s*\|\|\s*fetch/.test(sw), 'cache-first would serve stale code after an update');
  assert.match(sw, /catch[\s\S]{0,200}caches\.match/, 'the cache is only consulted when the network failed');
  // Mutations are not the worker's business at all.
  assert.match(sw, /req\.method !== 'GET'/);
});

test('what the worker may cache matches what the server actually serves', () => {
  const sw = read('sw.js');
  const server = read('server.js');
  const swPrefixes = /const SHELL_PREFIXES = \[([\s\S]*?)\];/.exec(sw);
  assert.ok(swPrefixes, 'SHELL_PREFIXES must be findable');
  const inSw = [...swPrefixes[1].matchAll(/'\/([a-z]+)\//g)].map((m) => m[1]).sort();
  // The static route's own directory list, read out of server.js rather than
  // restated here — the same drift guard the demo build uses. A directory added
  // to the server and not here is not a bug, it is only unavailable offline; a
  // directory here that the server does NOT serve is a cache entry for a 404.
  const routeRe = /\/\^\\\/\(([a-z|]+)\)\(\\\/\|\$\)\//.exec(server);
  assert.ok(routeRe, 'the static route regex must be findable in server.js');
  const inServer = routeRe[1].split('|').sort();
  const strays = inSw.filter((d) => !inServer.includes(d));
  assert.deepEqual(strays, [], 'these are cached but not served: ' + strays.join(', '));
});

test('the manifest link asks for credentials, or the app is silently uninstallable', () => {
  const html = read('index.html');
  const link = /<link[^>]+rel="manifest"[^>]*>/.exec(html);
  assert.ok(link, 'index.html must link a manifest');
  // THE one that has no symptom. A same-origin manifest is fetched with
  // credentials omitted by default; on a paired device that request arrives
  // without the pairing cookie, comes back 401, and the browser just never
  // offers to install — nothing in any console, exactly like the widget
  // stylesheet that came back 403 and was swallowed by CORB.
  assert.match(link[0], /crossorigin="use-credentials"/,
    'without this the manifest is fetched anonymously and refused on a paired device');
  assert.match(link[0], /href="\/manifest\.webmanifest"/, 'an absolute path: the scope is the whole app');
});

test('the worker is served from the root, uncached, with the scope header', () => {
  const server = read('server.js');
  const route = /reqPath === '\/sw\.js'[\s\S]{0,1400}?err500/.exec(server);
  assert.ok(route, 'the /sw.js route must exist');
  // From the ROOT: a worker's default scope is its own directory, so one served
  // under /public/ could only ever control /public/.
  assert.match(route[0], /'Service-Worker-Allowed': '\/'/);
  // no-store on the worker itself: it decides what everything else caches, so a
  // stale copy of IT is the one state there is no way back from.
  assert.match(route[0], /'Cache-Control': 'no-store'/);
  assert.match(route[0], /text\/javascript/);
});

test('registration is skipped everywhere it would be wrong', () => {
  const pwa = read('js/pwa.js');
  // An insecure context (the LAN door) — the browser would refuse anyway, and
  // asking produces a console error on every load of a perfectly fine page.
  assert.match(pwa, /window\.isSecureContext/);
  // The native app is already an app, with its own updater.
  assert.match(pwa, /__XENON_NATIVE__|isTauri/);
  // Any iframe: the iCUE widget, a ?panel= embed, the Edge preview stage. A
  // surface inside something else must never install anything.
  assert.match(pwa, /window\.top !== window\.self/);
  assert.match(pwa, /panel=/);
  // And the way out has to exist in code, not in a support answer.
  assert.match(pwa, /unregister/);
  assert.match(read('sw.js'), /xenon-unregister/, 'the worker must honour the removal message');
});
