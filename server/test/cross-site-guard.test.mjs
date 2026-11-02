// What a page on another website may do with the local server (cross-site.js).
// One rule over every path rather than a list of routes. These tests pin both
// the rule and the place it runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { refusedCrossSite, refusedSocketOrigin } = require('../cross-site.js');
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

const req = (method, headers = {}) => ({ method, headers });

// What real browsers send, written out once so each test reads as a scenario.
const SANDBOXED_IFRAME_POST = req('POST', { origin: 'null', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'content-type': 'text/plain;charset=UTF-8' });
const OLD_BROWSER_SANDBOXED_POST = req('POST', { origin: 'null', 'content-type': 'text/plain' });
const DASHBOARD_POST = req('POST', { origin: 'http://127.0.0.1:3030', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'content-type': 'application/json' });
const DASHBOARD_ON_LOCALHOST = req('POST', { origin: 'http://localhost:3030', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' });
const CLI_POST = req('POST', { 'content-type': 'application/json' });   // MCP bridge, Claude Code hooks, curl, Streamer.bot

test('a sandboxed frame on another site is refused, with or without Fetch Metadata', () => {
  assert.equal(refusedCrossSite(SANDBOXED_IFRAME_POST), true);
  assert.equal(refusedCrossSite(OLD_BROWSER_SANDBOXED_POST), true, 'Safari before 16.4 and Firefox before 90 send no Sec-Fetch-Site');
});

test('every method that changes something is covered, not only POST', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
    assert.equal(refusedCrossSite(req(method, { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' })), true, method);
    assert.equal(refusedCrossSite(req(method, { origin: 'null' })), true, method + ' from an opaque origin');
  }
});

test('the dashboard and local tools keep working', () => {
  assert.equal(refusedCrossSite(DASHBOARD_POST), false);
  assert.equal(refusedCrossSite(DASHBOARD_ON_LOCALHOST), false);
  assert.equal(refusedCrossSite(CLI_POST), false, 'no browser headers at all: a program on this PC');
  assert.equal(refusedCrossSite(req('POST', { 'sec-fetch-site': 'none' })), false, 'typed in the address bar');
  assert.equal(refusedCrossSite(req('GET', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' })), false);
});

test('a cross-site page cannot read an answer with fetch()', () => {
  assert.equal(refusedCrossSite(req('GET', { origin: 'null', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' })), true);
  assert.equal(refusedCrossSite(req('OPTIONS', { origin: 'null', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' })), true, 'and its preflight is not told to go ahead');
});

test('what the iCUE widgets and the website do still works', () => {
  // The iCUE widgets reach Xenon with <script> JSONP and an <img> probe, from
  // file:// or qrc://. Those loads are no-cors and cannot read plain JSON.
  assert.equal(refusedCrossSite(req('GET', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' })), false);
  assert.equal(refusedCrossSite(req('GET', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' })), false);
  // The guides on xenon-app.com link to http://127.0.0.1:3030.
  assert.equal(refusedCrossSite(req('GET', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' })), false);
});

test('the local sockets only open from our own pages', () => {
  assert.equal(refusedSocketOrigin(req('GET', { origin: 'null' })), true);
  assert.equal(refusedSocketOrigin(req('GET', { origin: 'null', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'websocket' })), true);
  assert.equal(refusedSocketOrigin(req('GET', { origin: 'http://127.0.0.1:3030', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'websocket' })), false);
  assert.equal(refusedSocketOrigin(req('GET', {})), false, 'a local program');
});

test('the rule runs on the loopback door for every path, before any route', () => {
  const at = SERVER.indexOf('if (!isRemote && refusedCrossSite(req))');
  assert.ok(at > 0, 'the general guard is in the request handler');
  assert.ok(at > SERVER.indexOf('const isRemote = remote !== null;'), 'after the door is known');
  assert.ok(at < SERVER.indexOf("if (req.method === 'OPTIONS') { res.writeHead(204)"), 'before the preflight reply');
  assert.ok(at < SERVER.indexOf("if (reqPath === '/' && req.method === 'GET')"), 'before the first route');
  assert.match(SERVER.slice(at, at + 200), /res\.writeHead\(403/);
});

test('the socket upgrade applies its rule after the loopback check', () => {
  const up = SERVER.slice(SERVER.indexOf("server.on('upgrade'"));
  const loop = up.indexOf('if (!isAllowedRequest(req)) { socket.destroy(); return; }');
  const strict = up.indexOf('if (refusedSocketOrigin(req)) { socket.destroy(); return; }');
  assert.ok(loop > 0 && strict > loop, 'both checks, loopback first');
  assert.ok(strict < up.indexOf('handleUpgrade'), 'before any socket is accepted');
});
