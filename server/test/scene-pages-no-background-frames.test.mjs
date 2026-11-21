// A scene page (data-scene: the desktop scene, scene.html, and a pump's widget,
// pump-widget.html) shows its own frame only. The dashboard already runs the Store
// widgets' background frames; a second copy on a wallpaper or a pump would answer
// every Deck key and hook twice (js/custom-widget/custom-widget.js syncServiceFrames).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';

const src = readFileSync(new URL('../js/custom-widget/custom-widget.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = src.indexOf('  function planServiceFrames(');
const end = src.indexOf("  // The dashboard's language changed", start);
const body = src.slice(start, end);

// A widget with a Deck key the person granted: the one kind that runs in the background anywhere.
const PKG = { id: 'deck-timer', name: 'Deck timer', entry: 'index.html', background: true, tile: true, deck: { handlers: [{ id: 'go' }] } };

function run(dataset) {
  const mounted = [];
  const ctx = {
    frames: new Map(), serviceRetries: new Map(), leftPage: new Map(), assetVersion: 1, SERVICE_FRAMES_MAX: 4,
    serviceLeftOut: [], window: {}, hubSettings: {},
    document: { documentElement: { dataset, hasAttribute: () => false }, createElement: () => ({ setAttribute() {}, remove() {} }) },
    sdk: () => ({ enabled: true }),
    cachedPackages: () => [PKG],
    grantsFor: () => ({ handlers: ['go'] }),
    isSuspended: () => false,
    sdkAssetBase: (id) => '/sdk/widget/' + id + '/',
    watchServiceHello() {}, guardFrame() {}, frameLeftPage() {},
    serviceHost: () => ({ appendChild: (f) => mounted.push(f) }),
    clearTimeout() {},
  };
  vm.runInNewContext(body + '\nsyncServiceFrames();', ctx);
  return mounted.length;
}

test('the dashboard runs the background frame of a widget with a granted Deck key', () => {
  assert.equal(run({}), 1);
});

test('a scene page never does: not the wallpaper, the screensaver, the preview or a pump', () => {
  for (const scene of ['wallpaper', 'saver', 'preview', 'pump']) assert.equal(run({ scene }), 0, scene);
});
