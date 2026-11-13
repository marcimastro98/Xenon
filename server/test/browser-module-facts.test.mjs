// What a page script that becomes an ES module relies on in the engine, pinned
// here so that a change to any of it fails a test with the reason next to it:
// the tag still gets its version, the file is still served as JavaScript, a page
// of ours may load it and a page that is not ours may not, and a paired device
// may ask for it. (How a module's place in the page is proven: tools/restructure/browser-module.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const assets = require('../asset-version.js');
const { refusedCrossSite } = require('../cross-site.js');
const { remotePathAllowed } = require('../remote-access.js');
const SERVER = engineSource();

test('a module tag gets the version of its file like any script tag, so the file may stay in the cache', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-module-facts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'js'));
  fs.writeFileSync(path.join(root, 'js', 'leaf.js'), 'export {};\n');
  const stat = fs.statSync(path.join(root, 'js', 'leaf.js'));
  const tag = assets.tagOf(stat, '5.1.0');
  const page = await assets.stamp('<script type="module" src="js/leaf.js"></script>\n', root, '5.1.0');
  assert.equal(page, `<script type="module" src="js/leaf.js?v=${encodeURIComponent(tag)}"></script>\n`);
  assert.equal(assets.cacheControl(tag, stat, '5.1.0'), 'private, max-age=31536000, immutable');
});

test('a file one module imports is asked for without a version, so the browser asks again at every load', async (t) => {
  // `import './other.js'` inside a module is not a tag: nothing stamps it. The answer is `no-cache`, which is
  // always fresh after an update and costs one round trip per file per load. The pilot module imports nothing.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-module-facts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'other.js'), 'export const a = 1;\n');
  assert.equal(assets.cacheControl(null, fs.statSync(path.join(root, 'other.js')), '5.1.0'), 'no-cache');
  const inside = "<script type=\"module\">import './js/other.js';</script>\n";
  assert.equal(await assets.stamp(inside, root, '5.1.0'), inside, 'only a tag with src is stamped');
});

test('a script is served as JavaScript and never type-sniffed: a browser refuses a module of any other type', () => {
  assert.match(SERVER, /'\.js': 'text\/javascript; charset=utf-8'/);
  assert.match(SERVER, /res\.setHeader\('X-Content-Type-Options', 'nosniff'\)/);
});

test('a page of ours loads a module, a page that is not ours cannot read one', () => {
  const refused = (headers, file = '/js/deck-popup.js') => refusedCrossSite({ method: 'GET', headers }, 3030, file, { jsonp: () => false });
  // A module is fetched in cors mode. From our own page that is a same-origin request.
  assert.equal(refused({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'script' }), false);
  const elsewhere = { origin: 'https://example.com', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'script' };
  assert.equal(refused(elsewhere), true, 'another site cannot import a script of the dashboard');
  // A widget frame has an opaque origin: it loads its own folder, never a script of the dashboard.
  const widgetFrame = { ...elsewhere, origin: 'null' };
  assert.equal(refused(widgetFrame), true);
  assert.equal(refused(widgetFrame, '/sdk/widget/clock/main.js'), false);
});

test('a paired device may ask for a page script', () => {
  // The request is same-origin for the device too, so the browser sends the pairing cookie with it as it does for a classic script.
  assert.equal(remotePathAllowed('/js/deck-popup.js', 'GET'), true);
  assert.equal(remotePathAllowed('/js/../data/settings.json', 'GET'), false);
});
