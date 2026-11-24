// While a program that paints the motherboard runs (iCUE with its GIGABYTE plugin, GIGABYTE
// Control Center, OpenRGB, SignalRGB), Xenon used to keep writing the same controller: after a
// reboot that started iCUE the fans flickered between two effects and the board's calls timed
// out. Now the watch (lighting-native/board-apps.js) leaves the board to that program until it
// quits, the Lighting page says who has it, and the board is set up again afterwards. iCUE
// without a motherboard plugin never touches the board, so it never takes the board from Xenon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { readFileSync } from './browser-source.mjs';
import { makeDom } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const { createBoardApps, icueBoardPlugin } = require('../lighting-native/board-apps.js');
const P = require('../lighting-native/fusion2-protocol.js');
const native = require('../lighting-native/index.js');
const hid = require('../hid/index.js');
const { driversOf } = require('../lights/drivers.js');

const NEVER = 1e9;

function watch(tables, icuePaints = async () => true) {
  const came = [];
  const gone = [];
  let i = 0;
  const w = createBoardApps({
    platform: 'win32', every: NEVER, icuePaints, onCome: (a) => came.push(a), onGone: (a) => gone.push(a),
    read: async () => tables[Math.min(i++, tables.length - 1)],
  });
  w.start();
  return { w, came, gone };
}

test('a program that paints the board is handed it once when it starts, and the board comes back once it quits', async () => {
  const { w, came, gone } = watch([['explorer'], ['explorer', 'icue'], ['icue', 'openrgb'], ['explorer']]);
  await w.check();
  assert.deepEqual(came, [], 'nothing runs: the board stays with Xenon');
  await w.check();
  assert.deepEqual(came, [['icue']]);
  await w.check();
  assert.deepEqual(came, [['icue']], 'a second program while the first runs: still one hand-over');
  await w.check();
  assert.deepEqual(gone, [['icue', 'openrgb']]);
  w.stop();
});

test('iCUE counts only with a motherboard plugin; a check that fails says no', async () => {
  const none = watch([['icue'], ['explorer']], async () => false);
  await none.w.check();
  await none.w.check();
  assert.deepEqual([none.came, none.gone], [[], []], 'iCUE without a board plugin never touches the board');
  none.w.stop();
  const broken = watch([['icue']], async () => { throw new Error('EACCES'); });
  await broken.w.check();
  assert.deepEqual(broken.came, []);
  broken.w.stop();
  const gcc = watch([['gcc']], async () => false);
  await gcc.w.check();
  assert.deepEqual(gcc.came, [['gcc']], 'the other programs always paint the board');
  gcc.w.stop();
});

test('the plugin check reads the plugins folder of iCUE', async () => {
  const root = path.join('pretend', 'Corsair');
  const tree = (plugins) => ({
    readdir: async (p) => {
      if (p === root) return ['Corsair iCUE5 Software', 'Other'];
      if (p === path.join(root, 'Corsair iCUE5 Software', 'plugins')) return plugins;
      throw new Error('ENOENT');
    },
  });
  assert.equal(await icueBoardPlugin({ fsp: tree(['Gigabyte', 'Nanoleaf']), root }), true);
  assert.equal(await icueBoardPlugin({ fsp: tree(['MSI']), root }), true);
  assert.equal(await icueBoardPlugin({ fsp: tree(['Nanoleaf', 'Philips Hue']), root }), false);
  assert.equal(await icueBoardPlugin({ fsp: { readdir: async () => { throw new Error('ENOENT'); } }, root }), false);
});

test('a board handed over gets no frame, preview, release or blackout until it is taken back', async () => {
  const sent = [];
  const reply = (fill) => { const b = Buffer.alloc(64); b[0] = 0xCC; fill(b); return b; };
  const info = reply((b) => { b[3] = 1; b[11] = 3; b.writeUInt32LE(((0x5711 << 16) | 1) >>> 0, 56); });
  const dev = {
    setFeature: async (buf) => { sent.push(buf); },
    getFeature: async () => (sent[sent.length - 1][1] === 0x60 ? info : reply(() => {})),
    close: async () => {},
  };
  const real = { list: hid.list, open: hid.open };
  hid.list = async () => [{ path: 'node', vendorId: P.VENDOR_ID, productId: 0x5711, usagePage: P.USAGE_PAGE, usage: P.USAGE }];
  hid.open = async () => dev;
  try {
    await native.start();
    const [board] = native.devices();
    native.yieldTo(['icue']);
    assert.deepEqual(native.status().yieldedTo, ['icue']);
    const at = sent.length;
    native.write(board, board.ledIds.map(() => ({ r: 255, g: 0, b: 0 })));
    assert.equal(await native.setPreview(board.id, 0, { whole: true }), false);
    await native.release();
    await native.powerDown();
    native.resume();
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, at, 'not one packet while iCUE paints the board');
    await native.retake();
    assert.deepEqual(native.status().yieldedTo, []);
    assert.ok(sent.length > at, 'taken back: the start-up packets go again');
  } finally {
    await native.stop();
    native.resume();
    Object.assign(hid, real);
  }
});

test('the lights hand the board over when such a program starts', () => {
  const src = readFileSync(new URL('../lights/configure.js', import.meta.url), 'utf8');
  assert.match(src, /onCome: \(apps\) => \{[\s\S]*?native\.yieldTo\(apps\);/);
});

const BOARD = { id: 'fusion2-1', model: 'Pretend Board', source: 'native', maker: 'GIGABYTE' };
const HUB = { id: 'hub-1', model: 'Pretend Hub', source: 'native', maker: 'CORSAIR' };
const yielded = (list) => ({ enabled: true, yieldedTo: list, controllers: [{ id: 'fusion2-1' }] });

test('who drives the lights names the program that has the board; the hub Xenon holds stays with Xenon', () => {
  const rows = driversOf({ devices: [BOARD, HUB], native: yielded(['icue', 'gcc']) });
  assert.deepEqual(rows[0], {
    id: 'fusion2-1', name: 'Pretend Board', brand: 'GIGABYTE', who: 'other',
    through: 'iCUE, GIGABYTE Control Center', reasonKey: 'lighting_board_other',
  });
  assert.equal(rows[1].who, 'xenon');
  assert.equal(driversOf({ devices: [BOARD], native: yielded([]) })[0].who, 'xenon');
});

test('the Lighting page shows that program and why, and the words exist in every language', () => {
  const FILES = ['lighting/lighting-ui.js', 'lighting-map/geometry.js', 'lighting-map/lighting-map.js', 'lighting/lighting-device.js', 'lighting-page/panels.js'];
  const { document } = makeDom();
  const window = {};
  const ctx = vm.createContext({ window, document, console, t: (k) => k, fetch: async () => ({ ok: true, json: async () => ({}) }) });
  for (const f of FILES) vm.runInContext(readFileSync(new URL('../js/' + f, import.meta.url), 'utf8'), ctx);
  const drivers = driversOf({ devices: [BOARD], native: yielded(['icue']) });
  const status = { available: true, enabled: true, effects: {}, devices: [BOARD], providers: [], drivers };
  const box = window.LightingPagePanels.devicesPanel(() => {}, status, () => {});
  const state = box.firstChild.querySelector('.lighting-who .lighting-who-state');
  assert.equal(state.textContent, 'iCUE');
  assert.ok(!state.className.includes('is-off'), 'not an error: someone drives them');
  assert.ok(box.firstChild.querySelector('[data-i18n="lighting_board_other"]'), 'why, under the row');
  for (const lang of ['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'nl', 'pt', 'ru', 'zh']) {
    const src = readFileSync(new URL(`../js/i18n/${lang}.js`, import.meta.url), 'utf8');
    assert.match(src, /\n {2}lighting_board_other: '[^'\n]+',\n/, lang);
  }
});
