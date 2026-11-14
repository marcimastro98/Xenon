// The engine the page check opens the pages in (tools/restructure/browser-check-engine.mjs):
// Chromium unless WebKit is asked for by name, never shown, never able to reach another
// host; two recordings are compared only when one engine made both; and one tree recorded
// in two engines is read as faults (what a person on that engine meets) apart from what
// is only the engines being two.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENGINES, REFUSED, askedFor, deadEnd, engineDifferences, engineFromArgs, engineName, engineOf, launchOptions, startEngine,
} from '../../tools/restructure/browser-check-engine.mjs';
import { compareRecordings } from '../../tools/restructure/browser-page-check.mjs';

const TOOLS = fileURLToPath(new URL('../../tools/restructure/', import.meta.url));

test('the engine is Chromium unless another one is named, and a name the check does not know is refused', () => {
  assert.deepEqual(ENGINES, ['chromium', 'webkit']);
  assert.equal(engineName(undefined), 'chromium');
  assert.equal(engineName(''), 'chromium');
  assert.equal(engineName('WebKit '), 'webkit');
  assert.throws(() => engineName('safari'), /"safari" is not an engine the page check knows: chromium or webkit/);
  assert.throws(() => engineName('firefox'), /not an engine/);
});

test('--engine is taken out of the command line and wins over XENON_PAGE_ENGINE', () => {
  assert.deepEqual(engineFromArgs(['record', '3043', 'out.json'], {}), { engine: 'chromium', rest: ['record', '3043', 'out.json'] });
  assert.deepEqual(engineFromArgs(['record', '3043', 'out.json'], { XENON_PAGE_ENGINE: 'webkit' }).engine, 'webkit');
  assert.deepEqual(engineFromArgs(['record', '--engine', 'webkit', '3043', 'out.json'], { XENON_PAGE_ENGINE: 'chromium' }), { engine: 'webkit', rest: ['record', '3043', 'out.json'] });
  assert.deepEqual(engineFromArgs(['record', '3043', 'out.json', 'HEAD', '--engine', 'chromium'], { XENON_PAGE_ENGINE: 'webkit' }).rest, ['record', '3043', 'out.json', 'HEAD']);
  assert.throws(() => engineFromArgs(['record', '--engine'], {}), /--engine needs a name/);
  assert.throws(() => engineFromArgs(['record'], { XENON_PAGE_ENGINE: 'edge' }), /not an engine/);
});

test('both engines are started unseen and blind to every host but this PC', () => {
  const chromium = launchOptions('chromium', { CHROME_EXE: 'C:/some/chrome.exe' });
  assert.equal(chromium.headless, true);
  assert.equal(chromium.executablePath, 'C:/some/chrome.exe');
  assert.deepEqual(chromium.args, ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1']);
  assert.equal(launchOptions('chromium', {}).executablePath, undefined);
  const webkit = launchOptions('webkit', { CHROME_EXE: 'C:/some/chrome.exe' }, 50123);
  assert.deepEqual(webkit, { headless: true, proxy: { server: 'http://127.0.0.1:50123', bypass: '127.0.0.1' } }, 'CHROME_EXE is Chromium\'s alone');
});

test('each engine has its own words for a request the check refused, and both are known', () => {
  assert.match('Failed to load resource: net::ERR_BLOCKED_BY_CLIENT', REFUSED);
  assert.match('Beacon API cannot load http://outside.invalid/b. Blocked by Web Inspector', REFUSED);
  assert.doesNotMatch('TypeError: undefined is not an object', REFUSED);
});

test('the dead end reads where a connection wanted to go from its first lines', () => {
  assert.equal(askedFor('CONNECT outside.invalid:443 HTTP/1.1\r\nHost: outside.invalid:443\r\n\r\n'), 'outside.invalid:443');
  assert.equal(askedFor('GET http://outside.invalid:81/a HTTP/1.1\r\nHost: outside.invalid:81\r\n\r\n'), 'http://outside.invalid:81');
  assert.equal(askedFor('GET /a HTTP/1.1\r\nUpgrade: websocket\r\nhost: outside.invalid:81\r\n\r\n'), 'outside.invalid:81');
  assert.equal(askedFor('\u0016\u0003\u0001'), '\u0016\u0003\u0001');
});

const knock = (port, text) => new Promise((resolve, reject) => {
  const socket = connect({ host: '127.0.0.1', port }, () => socket.write(text));
  let answer = '';
  socket.on('data', (data) => { answer += data; });
  socket.once('error', reject);
  socket.once('close', () => resolve(answer));
});

test('the dead end answers nothing, closes, keeps each place once, and is gone when closed', async () => {
  const end = await deadEnd();
  try {
    assert.equal(await knock(end.port, 'CONNECT outside.invalid:443 HTTP/1.1\r\n\r\n'), '');
    assert.equal(await knock(end.port, 'CONNECT outside.invalid:443 HTTP/1.1\r\n\r\n'), '');
    assert.equal(await knock(end.port, 'GET /chat HTTP/1.1\r\nHost: localhost:3030\r\n\r\n'), '');
    assert.deepEqual(end.asked, ['outside.invalid:443', 'localhost:3030']);
  } finally {
    await end.close();
  }
  await assert.rejects(knock(end.port, 'x'), /ECONNREFUSED/);
});

// A stand-in for Playwright: what it was started with, and whether it was closed.
function fakePlaywright({ fails = false } = {}) {
  const calls = [];
  const engine = (name) => ({ launch: async (options) => {
    calls.push({ name, options, closed: false });
    if (fails) throw new Error('the browser is not installed');
    return { version: () => '1.2', close: async () => { calls.at(-1).closed = true; } };
  } });
  return { calls, chromium: engine('chromium'), webkit: engine('webkit') };
}

test('starting WebKit opens a dead end for it and closing the engine closes both; Chromium needs none', async () => {
  const playwright = fakePlaywright();
  const webkit = await startEngine(playwright, 'webkit', {});
  const port = Number(new URL(playwright.calls[0].options.proxy.server).port);
  assert.deepEqual(webkit.about, { name: 'webkit', version: '1.2' });
  assert.equal(await knock(port, 'CONNECT outside.invalid:443 HTTP/1.1\r\n\r\n'), '');
  assert.deepEqual(webkit.outside, ['outside.invalid:443'], 'the recording gets the list the dead end fills');
  await webkit.close();
  assert.equal(playwright.calls[0].closed, true);
  await assert.rejects(knock(port, 'x'), /ECONNREFUSED/);
  const chromium = await startEngine(playwright, 'chromium', {});
  assert.equal(playwright.calls[1].name, 'chromium');
  assert.equal(playwright.calls[1].options.proxy, undefined);
  assert.deepEqual(chromium.outside, []);
  await chromium.close();
  assert.equal(playwright.calls[1].closed, true);
});

test('an engine that does not start leaves no dead end listening', async () => {
  const playwright = fakePlaywright({ fails: true });
  await assert.rejects(startEngine(playwright, 'webkit', {}), /not installed/);
  const port = Number(new URL(playwright.calls[0].options.proxy.server).port);
  await assert.rejects(knock(port, 'x'), /ECONNREFUSED/);
});

const view = (extra = {}) => ({ name: 'wide', address: '/', pageErrors: [], consoleErrors: [], failedRequests: [], refused: [], globals: ['App', 'fetch'], scripts: ['/js/a.js'],
  stylesheets: ['/styles/a.css'], rules: 'one', ruleCount: 3, declared: { App: 'object', start: 'function' }, ...extra });
const recording = (name, extra, more = {}) => ({ ...(name ? { engine: { name, version: '1', blank: name === 'webkit' ? ['fetch', 'webkitURL'] : ['fetch'], outside: [] } } : {}),
  views: [view(extra)], settings: { opened: true, changed: true }, ...more });

test('two recordings are compared only when one engine made both; a recording that names none is Chromium\'s', () => {
  assert.equal(engineOf(recording(null)), 'chromium');
  assert.deepEqual(compareRecordings(recording(null), recording('chromium'), { moves: [] }), []);
  assert.deepEqual(compareRecordings(recording('webkit'), recording('webkit'), { moves: [] }), []);
  const mixed = compareRecordings(recording('chromium'), recording('webkit'), { moves: [] });
  assert.equal(mixed.length, 1);
  assert.match(mixed[0], /first recording was made in chromium and the second in webkit/);
});

test('one tree in two engines: an error, a failed request, a module or a name that does not answer is a fault', () => {
  const chromium = recording('chromium', { modules: [{ address: '/js/m.js', exports: [] }] });
  const told = (extra, more) => engineDifferences(chromium, recording('webkit', { modules: [{ address: '/js/m.js', exports: [] }], globals: ['App', 'fetch', 'webkitURL'], ...extra }, more));
  assert.deepEqual(told({}).faults, []);
  assert.deepEqual(told({ pageErrors: ['x is not defined'] }).faults, ['wide: page error only in webkit: x is not defined']);
  assert.deepEqual(told({ consoleErrors: ['no gesture'] }).faults, ['wide: console error only in webkit: no gesture']);
  assert.deepEqual(told({ failedRequests: ['/js/a.js 404'] }).faults, ['wide: failed request only in webkit: /js/a.js 404']);
  assert.deepEqual(told({ modules: [{ address: '/js/m.js', error: 'Importing binding name' }] }).faults, ['wide: the module /js/m.js did not run: Importing binding name']);
  assert.deepEqual(told({ modules: [] }).faults, ['wide: the module /js/m.js is not loaded in webkit']);
  assert.deepEqual(told({ declared: { App: 'object', start: 'undefined' } }).faults, ['wide: top-level names that answer differently: start (function in chromium, undefined in webkit)']);
  assert.deepEqual(told({ globals: ['fetch', 'webkitURL'] }).faults, ['wide: names the page puts on window only in chromium: App']);
  assert.deepEqual(told({ scripts: [] }).faults, ['wide: loads other scripts, or in another order (1 in chromium, 0 in webkit)']);
  assert.deepEqual(told({ probe: { drawn: false } }).faults, ['wide: the page\'s own question is answered differently (undefined in chromium, {"drawn":false} in webkit)']);
  assert.deepEqual(told({}, { settings: { opened: true, changed: false } }).faults, ['settings: "changed" failed in webkit']);
  assert.deepEqual(engineDifferences(chromium, { ...recording('webkit'), views: [] }).faults, ['wide: opened in chromium, not in webkit']);
});

test('one tree in two engines: the engine\'s own names, the way it writes a rule back and the news of the day are not faults', () => {
  const chromium = recording('chromium', { consoleErrors: ['only here'], refused: ['https://news.example'] });
  const webkit = recording('webkit', { globals: ['App', 'fetch', 'webkitURL'], rules: 'another', refused: ['https://sport.example'] });
  const { faults, differences } = engineDifferences(chromium, webkit);
  assert.deepEqual(faults, []);
  assert.deepEqual(differences, [
    'wide: console error only in chromium: only here',
    'wide: names of the engine itself on window: 1 in chromium, 2 in webkit',
    'wide: the style rules read back differ (3 in chromium, 3 in webkit)',
    'wide: asks https://sport.example only in webkit (refused)',
    'wide: asks https://news.example only in chromium (refused)',
  ]);
});

test('the side copy refuses an engine it does not know before it builds anything, and both tools say how they are called', () => {
  const folder = path.join(mkdtempSync(path.join(os.tmpdir(), 'xenon-engine-test-')), 'copy');
  try {
    const run = spawnSync(process.execPath, [path.join(TOOLS, 'side-copy.mjs'), 'record', folder, '3043', path.join(folder, 'out.json'), '--engine', 'safari'], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /side-copy: "safari" is not an engine the page check knows/);
    assert.equal(existsSync(folder), false);
  } finally {
    rmSync(path.dirname(folder), { recursive: true, force: true });
  }
  const copy = spawnSync(process.execPath, [path.join(TOOLS, 'side-copy.mjs')], { encoding: 'utf8' });
  assert.equal(copy.status, 2);
  assert.match(copy.stderr, /record <folder> <port> <out\.json> \[baseRev\] \[--engine chromium\|webkit\]\s*$/);
  const check = spawnSync(process.execPath, [path.join(TOOLS, 'browser-page-check.mjs')], { encoding: 'utf8' });
  assert.equal(check.status, 2);
  assert.match(check.stderr, /record <port> <out\.json> \[settleMs\] \[--engine chromium\|webkit\]\n.*compare <before\.json> <after\.json>\n.*engines <chromium\.json> <webkit\.json>\s*$/);
});
