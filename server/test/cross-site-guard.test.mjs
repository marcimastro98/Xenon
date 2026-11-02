// What a page that is not ours may do with the local server (cross-site.js).
// One rule over every path rather than a list of routes. These tests pin the
// rule, every legitimate caller it must keep working, and the place it runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { refusedCrossSite, refusedSocketOrigin, isPage } = require('../cross-site.js');
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

const req = (method, headers = {}) => ({ method, headers });
// The JSONP routes as server.js defines them.
const JSONP = new Set(['/system', '/network', '/notes', '/media', '/audio', '/status', '/toggle', '/mic/volume', '/volume/set', '/speaker/mute']);
const opts = { jsonp: (p) => JSONP.has(p) || p.startsWith('/media/') };
const refused = (r, path = '/', port = 3030) => refusedCrossSite(r, port, path, opts);

// What browsers send, written out once so each test reads as a scenario.
const XSITE = { 'sec-fetch-site': 'cross-site' };
const IMG = { ...XSITE, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' };
const SCRIPT = { ...XSITE, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' };
const LINK = { ...XSITE, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
const SANDBOXED_POST = { origin: 'null', ...XSITE, 'sec-fetch-mode': 'no-cors', 'content-type': 'text/plain;charset=UTF-8' };
const SAME = { origin: 'http://127.0.0.1:3030', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' };

test('a sandboxed frame on another site cannot run anything, with or without Fetch Metadata', () => {
  assert.equal(refused(req('POST', SANDBOXED_POST), '/actions/run'), true);
  assert.equal(refused(req('POST', { origin: 'null', 'content-type': 'text/plain' }), '/actions/run'), true, 'Safari < 16.4, Firefox < 90');
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(refused(req(m, { ...XSITE, 'sec-fetch-mode': 'no-cors' }), '/settings'), true, m);
    assert.equal(refused(req(m, { origin: 'null' }), '/settings'), true, m + ' from an opaque origin');
  }
});

test('a page elsewhere cannot read an answer, nor be told a preflight may go ahead', () => {
  assert.equal(refused(req('GET', { origin: 'null', ...XSITE, 'sec-fetch-mode': 'cors' }), '/settings'), true);
  assert.equal(refused(req('GET', { origin: 'null' }), '/settings'), true, 'old browser, Origin only');
  assert.equal(refused(req('OPTIONS', { origin: 'null', ...XSITE, 'sec-fetch-mode': 'cors' }), '/actions/run'), true);
});

test('an <img> or <script> elsewhere cannot reach a route with side effects', () => {
  // The whole class at once: a route added tomorrow is covered too.
  for (const path of ['/deck/app-icon', '/events', '/api/stocks', '/stream/youtube/broadcast', '/api/ai/cli/status',
    '/obs/scenes', '/api/ai-local/scan', '/weather', '/update/check', '/api/ha/camera/snapshot/camera.front', '/a-route-added-later']) {
    assert.equal(refused(req('GET', IMG), path), !JSONP.has(path), 'img ' + path);
  }
  assert.equal(refused(req('GET', SCRIPT), '/settings'), true, 'settings never ship as a script');
});

test('a link from elsewhere opens a page, never an API route', () => {
  for (const page of ['/', '/pair', '/deck-popup', '/spotlight', '/menu', '/scene', '/screen-alerts', '/draw', '/shell-driver', '/sdk-service', '/index.html']) {
    assert.equal(refused(req('GET', LINK), page), false, page);
  }
  assert.equal(refused(req('GET', LINK), '/stream/spotify/callback'), false, 'Spotify sign-in comes back here');
  for (const api of ['/events', '/notes', '/actions/run', '/api/settings', '/update/check']) {
    assert.equal(refused(req('GET', LINK), api), true, api);
  }
});

test('the dashboard, every page of ours and local programs keep working', () => {
  assert.equal(refused(req('POST', SAME), '/actions/run'), false);
  assert.equal(refused(req('GET', SAME), '/settings'), false);
  assert.equal(refused(req('POST', { ...SAME, origin: 'http://localhost:3030' }), '/actions/run'), false);
  assert.equal(refused(req('POST', { ...SAME, origin: 'http://[::1]:3030' }), '/actions/run'), false);
  assert.equal(refused(req('GET', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }), '/deck/app-icon'), false);
  assert.equal(refused(req('POST', {}), '/actions/run'), false, 'a program on this PC sends no browser headers');
  assert.equal(refused(req('GET', { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' }), '/'), false, 'typed in the address bar, or opened by the app');
  assert.equal(refused(req('POST', { origin: 'http://127.0.0.1:4040' }), '/actions/run', 4040), false, 'XENON_PORT is honoured');
});

test('the iCUE widgets keep working', () => {
  // JSONP <script> on the polled routes, an <img> probe, the dashboard in an iframe.
  assert.equal(refused(req('GET', SCRIPT), '/status'), false);
  assert.equal(refused(req('GET', SCRIPT), '/media/abc'), false);
  assert.equal(refused(req('GET', IMG), '/ping'), false);
  assert.equal(refused(req('GET', { ...XSITE, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }), '/'), false);
  // Qt WebEngine builds that send no Fetch Metadata are not touched at all.
  assert.equal(refused(req('GET', {}), '/toggle'), false);
});

test('the native splash and public files load from elsewhere', () => {
  assert.equal(refused(req('GET', { ...XSITE, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'empty' }), '/ping'), false);
  for (const f of ['/styles/main.css', '/js/deck.js', '/assets/logo.png', '/fonts/inter.woff2', '/icon-pack/x/a.svg', '/uploads/w.jpg', '/sdk/tile/pkg', '/font/f.woff2', '/sound-pack/p/a.mp3']) {
    assert.equal(refused(req('GET', IMG), f), false, f);
  }
  assert.equal(refused(req('GET', IMG), '/api/x/y.png'), true, 'an API route is never a public file');
});

test('a page served by another program on another local port is not us', () => {
  const other = { origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' };
  assert.equal(refused(req('POST', other), '/actions/run'), true);
  assert.equal(refused(req('GET', other), '/settings'), true);
  assert.equal(refused(req('GET', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }), '/deck/app-icon'), true);
  assert.equal(refused(req('POST', { origin: 'http://localhost:8080' }), '/actions/run'), true, 'old browser, Origin only');
  assert.equal(refused(req('POST', { origin: 'https://127.0.0.1:3030' }), '/actions/run'), true, 'another scheme is another origin');
});

test('a sandboxed widget still loads its own module scripts and fonts', () => {
  const moduleLoad = { origin: 'null', ...XSITE, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'script' };
  assert.equal(refused(req('GET', moduleLoad), '/sdk/widget/clock/main.js'), false);
  assert.equal(refused(req('GET', { ...moduleLoad, 'sec-fetch-dest': 'font' }), '/sdk/widget/clock/font.woff2'), false);
  assert.equal(refused(req('GET', moduleLoad), '/sdk/wk/abc/clock/main.js'), false);
  assert.equal(refused(req('POST', moduleLoad), '/sdk/widget/clock/main.js'), true, 'only reads');
  assert.equal(refused(req('GET', moduleLoad), '/sdk/store'), true, 'only that folder');
});

test('the local sockets only open from our own pages', () => {
  assert.equal(refusedSocketOrigin(req('GET', { origin: 'null' })), true);
  assert.equal(refusedSocketOrigin(req('GET', { origin: 'http://localhost:8080' })), true);
  assert.equal(refusedSocketOrigin(req('GET', { origin: 'http://127.0.0.1:3030', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'websocket' })), false);
  assert.equal(refusedSocketOrigin(req('GET', {})), false, 'a local program');
});

test('the rule runs on the loopback door for every path, before any route', () => {
  const at = SERVER.indexOf('if (!isRemote && refusedCrossSite(req, PORT, reqPathEarly, { jsonp: isJsonpAllowed }))');
  assert.ok(at > 0, 'the general guard is in the request handler');
  assert.ok(at > SERVER.indexOf('const isRemote = remote !== null;'), 'after the door is known');
  assert.ok(at < SERVER.indexOf("if (req.method === 'OPTIONS') { res.writeHead(204)"), 'before the preflight reply');
  assert.ok(at < SERVER.indexOf("if (reqPath === '/' && req.method === 'GET')"), 'before the first route');
  assert.match(SERVER.slice(at, at + 200), /res\.writeHead\(403/);
});

test('the socket upgrade applies its rule after the loopback check', () => {
  const up = SERVER.slice(SERVER.indexOf("server.on('upgrade'"));
  const loop = up.indexOf('if (!isAllowedRequest(req)) { socket.destroy(); return; }');
  const strict = up.indexOf('if (refusedSocketOrigin(req, PORT)) { socket.destroy(); return; }');
  assert.ok(loop > 0 && strict > loop, 'both checks, loopback first');
  assert.ok(strict < up.indexOf('handleUpgrade'), 'before any socket is accepted');
});

test('every HTML page the server answers is one a link may open', () => {
  // A page added later without listing it would refuse links from elsewhere;
  // this keeps PAGES honest.
  const routes = SERVER.split(/\n  \} else if \(/);
  const pages = [];
  for (const chunk of routes) {
    const m = chunk.match(/reqPath === '([^']+)'/);
    if (m && /text\/html/.test(chunk.slice(0, 6000)) && /req\.method === 'GET'|method === 'GET'/.test(chunk.slice(0, 300))) pages.push(m[1]);
  }
  assert.ok(pages.length >= 5, 'found the HTML routes: ' + pages.join(' '));
  for (const p of pages) assert.equal(isPage(p), true, p + ' answers HTML but is not in PAGES');
});

test('the JSONP list matches the server, and personal data stays off it', () => {
  const at = SERVER.indexOf('const JSONP_PATHS = new Set([');
  const list = new Set([...SERVER.slice(at, SERVER.indexOf(']);', at)).matchAll(/'([^']+)'/g)].map((m) => m[1]));
  assert.deepEqual([...list].sort(), [...JSONP].sort(), 'keep the test copy in step with server.js');
  assert.equal(list.has('/events'), false, 'a calendar is personal: any page could read it with a <script>');
  assert.match(SERVER, /\(k === 'win' \|\| k === 'hostname'\) \? undefined : v/, 'window titles and the computer name stay out of JSONP');
});

test('the calendar is saved by POST only, never by a link', () => {
  assert.doesNotMatch(SERVER, /searchParams\.has\('save'\)\)\)/);
  assert.match(SERVER, /reqPath === '\/events' && req\.method === 'POST'\) \{/);
  assert.doesNotMatch(SERVER, /reqPath === '\/events'[^\n]*searchParams\.get\('data'\)/);
});

test('no site can frame a page of ours, and no answer is ever type-sniffed', () => {
  // Clickjacking: the dashboard in an invisible frame, a click steered onto a
  // Deck key. Only our own pages and the iCUE widget (a local file) may frame.
  const csp = SERVER.indexOf(`res.setHeader('Content-Security-Policy', "frame-ancestors 'self' file: qrc:");`);
  const sniff = SERVER.indexOf(`res.setHeader('X-Content-Type-Options', 'nosniff');`);
  assert.ok(csp > 0 && sniff > 0, 'both headers are set');
  const firstRoute = SERVER.indexOf("if (reqPath === '/' && req.method === 'GET')");
  assert.ok(csp < firstRoute && sniff < firstRoute, 'before any route answers');
  assert.match(SERVER, /const err500 = msg {2}=> \{ res\.writeHead\(500, \{ 'Content-Type': 'text\/plain; charset=utf-8' \}\)/);
});
