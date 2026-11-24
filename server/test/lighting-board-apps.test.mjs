// A program that paints the motherboard (iCUE with its GIGABYTE plugin, GIGABYTE Control
// Center, OpenRGB, SignalRGB) quits and leaves the ARGB headers on the board's own effect,
// while Xenon still thinks it holds them: fans white, deaf to colours and alerts, only the
// onboard zones changing. Seen on a real IT5711 after iCUE was opened and closed. The watch
// (lighting-native/board-apps.js) sees the last such program go, and the board is set up
// again from scratch (Fusion2Controller.retake, native.retake), as a fresh start does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync } from './browser-source.mjs';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { createBoardApps, namesReader, BOARD_APPS } = require('../lighting-native/board-apps.js');
const P = require('../lighting-native/fusion2-protocol.js');
const { Fusion2Controller } = require('../lighting-native/fusion2.js');
const native = require('../lighting-native/index.js');
const hid = require('../hid/index.js');

const NEVER = 1e9;   // the timer never fires in a test: check() is called by hand

function watch(tables, opts = {}) {
  const gone = [];
  let i = 0;
  const w = createBoardApps({
    platform: 'win32', every: NEVER, onGone: (apps) => gone.push(apps),
    read: async () => tables[Math.min(i++, tables.length - 1)], ...opts,
  });
  return { w, gone };
}

test('the board is taken back once, when the last program that paints it quits', async () => {
  const { w, gone } = watch([['explorer', 'icue'], ['icue'], ['explorer'], ['explorer']]);
  w.start();
  await w.check();
  assert.deepEqual(w.running(), ['icue']);
  await w.check();
  assert.deepEqual(gone, []);
  await w.check();
  assert.deepEqual(gone, [['icue']]);
  await w.check();
  assert.deepEqual(gone, [['icue']], 'nothing ran since: nothing to take back');
  w.stop();
});

test('two programs: the board waits for both; a table nobody could read changes nothing', async () => {
  const { w, gone } = watch([['icue', 'signalrgb'], ['signalrgb'], null, ['explorer']]);
  w.start();
  await w.check();
  await w.check();
  assert.deepEqual(gone, [], 'SignalRGB still paints it');
  await w.check();
  assert.deepEqual(w.running(), ['signalrgb'], 'an unreadable table is not a program gone');
  await w.check();
  assert.deepEqual(gone, [['signalrgb']]);
  w.stop();
});

test('nothing running at the start, a stopped watch, or a read that throws never takes the board', async () => {
  const quiet = watch([['explorer'], ['explorer']]);
  quiet.w.start();
  await quiet.w.check();
  assert.deepEqual(quiet.gone, []);
  quiet.w.stop();

  const stopped = watch([['gcc'], ['explorer']]);
  stopped.w.start();
  await stopped.w.check();
  stopped.w.stop();
  assert.deepEqual(stopped.w.running(), []);
  await stopped.w.check();
  assert.deepEqual(stopped.gone, [], 'stopped: Xenon holds no board');

  const broken = createBoardApps({ platform: 'win32', every: NEVER, onGone: () => assert.fail('no take back'), read: async () => { throw new Error('EIO'); } });
  broken.start();
  assert.deepEqual(await broken.check(), []);
  broken.stop();
});

test('one look at a time, and no watch where no board program is known', async () => {
  let reads = 0;
  let open;
  const w = createBoardApps({ platform: 'win32', every: NEVER, onGone: () => {}, read: () => { reads++; return new Promise((r) => { open = r; }); } });
  w.start();
  const a = w.check();
  const b = w.check();
  assert.equal(a, b);
  open(['icue']);
  await a;
  assert.equal(reads, 1);
  w.stop();
  const mac = createBoardApps({ platform: 'darwin', onGone: () => {} });
  mac.start();
  assert.deepEqual(await mac.check(), []);
  mac.stop();
  assert.deepEqual(BOARD_APPS.win32, ['icue', 'gcc', 'openrgb', 'signalrgb']);
});

test('Linux reads the process names from /proc', async () => {
  const root = path.join('pretend', 'proc');
  const files = { [path.join(root, '12', 'comm')]: 'openrgb\n', [path.join(root, '40', 'comm')]: 'bash\n' };
  const fsp = {
    readdir: async () => ['12', '40', 'self', 'meminfo'],
    readFile: async (p) => { if (p in files) return files[p]; throw new Error('ENOENT'); },
  };
  const read = namesReader('linux', { fsp, procRoot: root });
  assert.deepEqual(await read(), ['openrgb', 'bash']);
  const gone = [];
  const w = createBoardApps({ platform: 'linux', every: NEVER, onGone: (a) => gone.push(a), read });
  w.start();
  await w.check();
  delete files[path.join(root, '12', 'comm')];
  await w.check();
  assert.deepEqual(gone, [['openrgb']]);
  w.stop();
});

// A controller on a pretend USB link: every packet it sends.
function controller() {
  const ctl = new Fusion2Controller({ productId: 0x5711 });
  const sent = [];
  ctl.dev = { setFeature: async (buf) => { sent.push(buf); } };
  ctl.info = /** @type {any} */ ({ supportFlags: 0x02 });
  ctl.orders = [0, 1, 2, 3].map(() => P.byteOrder(0));
  return { ctl, sent };
}
const cmds = (sent) => sent.map((p) => p[1]);
const FRAME = [new Array(8).fill({ r: 255, g: 0, b: 0 }), null, null, null];

test('retake sends the start-up packets again and the next frame takes the headers from scratch', async () => {
  const { ctl, sent } = controller();
  await ctl.write(FRAME, []);
  assert.deepEqual(cmds(sent).slice(0, 2), [P.CMD.LED_COUNT, P.CMD.EFFECTS_OFF]);
  sent.length = 0;
  await ctl.write(FRAME, []);
  assert.deepEqual(sent, [], 'the same frame again: the controller thinks nothing changed');
  await ctl.retake();
  assert.deepEqual(cmds(sent), [P.CMD.LAMP_ARRAY, P.CMD.BEAT]);
  sent.length = 0;
  await ctl.write(FRAME, []);
  assert.deepEqual(cmds(sent).slice(0, 2), [P.CMD.LED_COUNT, P.CMD.EFFECTS_OFF], 'headers taken again');
  assert.equal(cmds(sent).at(-1), P.CMD.APPLY, 'and the same frame painted again');
});

test('native.retake takes every board back, but never while the PC is going off', async () => {
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
    await native.powerDown();
    const atDown = sent.length;
    await native.retake();
    assert.equal(sent.length, atDown, 'halted: the headers stay black');
    native.resume();
    await native.retake();
    const again = cmds(sent.slice(atDown));
    assert.ok(again.includes(P.CMD.BEAT) && again.every((c) => c === P.CMD.BEAT || c === P.CMD.LAMP_ARRAY), 'awake: the start-up packets go again');
  } finally {
    await native.stop();
    native.resume();
    Object.assign(hid, real);
  }
});

test('the lights watch only while Xenon holds a board, retake and repaint, and stop on quit', () => {
  const src = readFileSync(new URL('../lights/configure.js', import.meta.url), 'utf8');
  assert.match(src, /onGone: \(apps\) => \{\n\s+if \(bridge\.poweredDown\) return;[\s\S]*?native\.retake\(\)\.then\(\(\) => \{ bridge\.lastWrite\.clear\(\); apply\(\); \}\);/);
  assert.match(src, /if \(native\.status\(\)\.controllers\.length\) boardApps\.start\(\);\n\s+else boardApps\.stop\(\);/);
  assert.match(src, /\.then\(\(\) => \{ syncBoardApps\(\); bridge\.lastWrite\.clear\(\); apply\(\); \}\);/);
  assert.match(src, /await native\.start\(\{ rescan: true \}\);\n\s+syncBoardApps\(\);/);
  assert.match(src, /async function closeNative\(\) \{\n\s+boardApps\.stop\(\);\n\s+await native\.stop\(\);/);
  const lighting = engineSource('server/lights/lighting.js');
  assert.match(lighting, /setNativeChangeHook: native\.setChangeHook, closeNative,/);
  assert.doesNotMatch(lighting, /closeNative: native\.stop/);
});
