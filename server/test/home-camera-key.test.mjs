// The Deck key "Show camera" (js/capabilities/catalog-home.js, smart-home/camera-show.js): it
// finds a camera the way Bit does, sends only a loopback proxy path to the dashboards, says
// plainly when there is no camera or no such name, and a paired phone may press it. Every camera
// and name here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from './browser-source.mjs';

const require = createRequire(import.meta.url);
const { run } = require('../smart-home/camera-show.js');
const { CAPABILITIES } = require('../js/capabilities/capability-catalog.js');
const { validateAction } = require('../js/deck/deck-actions.js');
const { FREE } = require('../paired/remote-actions.js');
const { createCapabilities } = require('../capabilities/index.js');
const { DECK_ERR_TEXT } = require('../js/deck/deck-error-text.js');

const SETTINGS = { unifi: { host: 'console.example', username: 'x', password: 'y' }, homeAssistant: { url: 'http://ha.example:8123', token: 't' } };
const engines = (unifi = [], ha = []) => ({
  deckUnifi: { cameras: async () => unifi },
  deckHa: { cameras: async () => ha },
});
const CAMS = engines(
  [{ id: 'cam0001abcd', name: 'Ingresso', connected: true }],
  [{ id: 'camera.garden', name: 'Giardino', area: 'Fuori' }],
);

async function press(action, opts = {}) {
  const sent = [];
  const out = await run(action, { engines: opts.engines || CAMS, settings: async () => opts.settings ?? SETTINGS, send: (type, data) => sent.push({ type, data }) });
  return { out, sent };
}

test('a name, part of one or an area picks the camera; only its proxy path travels', async () => {
  const { out, sent } = await press({ camera: 'giardino' });
  assert.deepEqual(out, { ok: true, shown: 'Giardino' });
  assert.deepEqual(sent, [{ type: 'home_camera', data: { name: 'Giardino', pic: '/api/ha/camera/snapshot/camera.garden' } }]);
  assert.equal((await press({ camera: 'fuori' })).out.shown, 'Giardino');
  assert.equal((await press({ camera: 'ingr' })).out.shown, 'Ingresso');
});

test('empty takes the first camera; a name nobody has and no camera at all say so', async () => {
  assert.equal((await press({})).sent[0].data.pic, '/api/unifiprotect/snapshot/cam0001abcd');
  const none = await press({ camera: 'Cantina' });
  assert.deepEqual(none.out, { ok: false, error: 'no_camera' });
  assert.equal(none.sent.length, 0);
  assert.deepEqual((await press({}, { settings: {} })).out, { ok: false, error: 'no_cameras' });
  assert.deepEqual((await press({}, { engines: engines() })).out, { ok: false, error: 'no_cameras' });
});

test('a camera id that is not one never becomes a path', async () => {
  const odd = engines([{ id: '../../etc', name: 'Strana' }], [{ id: 'light.kitchen', name: 'Cucina' }]);
  assert.deepEqual((await press({ camera: 'Strana' }, { engines: odd })).out, { ok: false, error: 'no_cameras' });
});

test('the catalog: a Deck key with an optional camera name, no AI twin, any OS, a phone may press it', () => {
  const cap = CAPABILITIES.find((c) => c.type === 'homeCamera');
  assert.ok(cap);
  assert.equal(cap.capability.ai, undefined, 'Bit has home_camera of its own');
  assert.equal(cap.capability.requires, 'homeCameras');
  assert.equal(createCapabilities({}).probes().homeCameras, true);
  assert.deepEqual(validateAction({ type: 'homeCamera' }), { type: 'homeCamera' });
  assert.deepEqual(validateAction({ type: 'homeCamera', camera: 'Giardino', evil: 1 }), { type: 'homeCamera', camera: 'Giardino' });
  assert.equal(validateAction({ type: 'homeCamera', camera: 'x'.repeat(200) }).camera.length, 80, 'a long name is cut');
  assert.ok(FREE.has('homeCamera'));
  assert.ok(DECK_ERR_TEXT.no_cameras && DECK_ERR_TEXT.no_camera);
});

test('the runner hands the key to camera-show.js', async () => {
  const seen = [];
  const caps = createCapabilities({ home: { run: async (a) => { seen.push(a); return { ok: true }; } } });
  assert.deepEqual(await caps.run({ type: 'homeCamera', camera: 'Giardino' }), { ok: true });
  assert.deepEqual(seen, [{ type: 'homeCamera', camera: 'Giardino' }]);
});

test('every page with the Deck loads the home catalog before the main one', () => {
  for (const page of ['../index.html', '../deck-popup.html', '../js/layers/layer-tiles.js']) {
    const src = readFileSync(new URL(page, import.meta.url), 'utf8');
    const home = src.indexOf('js/capabilities/catalog-home.js');
    assert.ok(home > 0 && home < src.indexOf('js/capabilities/capability-catalog.js'), page);
  }
});
