// A Store widget as a pump's face: pump-widget.html runs it with the dashboard's own
// bridge (js/pump/pump-widget-host.js), framed by the face page's Widget face
// (js/pump/face-widget.js). The sandbox is the dashboard's, the page is a viewer, and
// only this PC opens it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from './browser-source.mjs';

const require = createRequire(import.meta.url);
const { createPumpStore } = require('../pump-screen/store.js');
const { createPumpLive } = require('../pump-screen/live.js');
const { createRoutes } = require('../pump-screen/handlers.js');
const { remotePathAllowed } = require('../paired/remote-access.js');
const { isPage } = require('../http/cross-site.js');

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const PAGE = read('../pump-widget.html');
const HOST = read('../js/pump/pump-widget-host.js');
const FACE = read('../js/pump/face-widget.js');

test('the route serves the widget page, which only this PC opens', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-pump-widget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createPumpStore({ dataDir: dir });
  const routes = createRoutes({ store, live: createPumpLive({ store, broadcast: () => {} }) });
  let sent = '';
  await routes['GET /pump-widget']({}, {}, { sendPage: async (html) => { sent = html; } });
  assert.match(sent, /<html lang="en" data-scene="pump">/);
  assert.equal(remotePathAllowed('/pump-widget', 'GET'), false, 'never from a paired phone');
  assert.equal(isPage('/pump-widget'), true, 'a page: a script tag from another site cannot load it');
});

test('the widget runs in the dashboard sandbox: scripts only, never its own origin', () => {
  assert.match(HOST, /frame\.setAttribute\('sandbox', 'allow-scripts'\);/);
  assert.match(HOST, /frame\.setAttribute\('referrerpolicy', 'no-referrer'\);/);
  assert.doesNotMatch(HOST + PAGE + FACE, /allow-same-origin/);
  assert.match(HOST, /frame\.src = widgets\(\)\.assetBase\(pkg\.id\) \+ pkg\.entry;/, 'its files come from the SDK route, as on the dashboard');
});

test('the page is a viewer: it never saves the settings and never asks for a permission', () => {
  assert.doesNotMatch(HOST, /method: 'POST'|requestGrant|saveHubSettings|localStorage/);
  assert.match(HOST, /return widgets\(\)\.packageGranted\(pkg\) \? \{ pkg \} : \{ why: 'ungranted' \};/);
  assert.doesNotMatch(PAGE, /<script>|\son[a-z]+="/, "no inline script or handler");
  assert.doesNotMatch(PAGE, /deck-actions\.js/, 'no Deck: a pump runs no background frame');
});

test('the face reads only the page state, and the clock stands in while the widget cannot show', () => {
  assert.match(FACE, /frame\.contentDocument\?\.documentElement\?\.dataset\.state/);
  assert.match(FACE, /const off = s !== 'on';/);
  assert.match(FACE, /normalizeFace\(\{ face: 'clock', weather: false \}\)/);
  assert.match(FACE, /stand = \{ node, impl: Kit\.get\('face', own\.face\)\(node, own\) \}/);
  assert.match(read('../pump-face.html'), /<script src="js\/pump\/face-widget\.js"><\/script>/);
});
