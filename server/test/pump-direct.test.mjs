// Xenon on a pump screen with no other program in between (pump-screen/direct.js and the parts
// around it): it draws only while it is on, a screen it has a driver for is plugged in and none of
// that screen's own programs runs; it steps aside within a check when iCUE comes back, never closes
// it, stops everything on a failure and waits longer each time, and the setting survives a restart
// and a backup. Fake USB, browser and timers only: nothing touches a device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Direct = require('../pump-screen/direct.js');
const { createPumpApps } = require('../pump-screen/direct-apps.js');
const { directAllowed, startPumpDirect } = require('../pump-screen/direct-start.js');
const Lcd = require('../pump-screen/lcd-corsair.js');
const Model = require('../js/pump/pump-model.js');
const Edit = require('../pump-screen/edit.js');
const { createPumpStore } = require('../pump-screen/store.js');
const { createPumpBackup } = require('../pump-screen/backup.js');

const PANEL = Lcd.panelOf(0x1b1c, 0x0c4e);
const PUMP = { brand: 'corsair', route: 'icue', vendorId: 0x1b1c, productId: 0x0c4e, direct: true };

function rig({ on = true, plugged = [PUMP], apps = [], failStart = null } = {}) {
  /** @type {any} */
  const r = { on, plugged, apps, failStart, timers: [], links: [], browsers: [], shown: [], changes: 0, now: 0 };
  const deps = {
    wanted: () => r.on,
    detect: async () => r.plugged,
    panelOf: (p) => (p.direct ? Lcd.panelOf(p.vendorId, p.productId) : null),
    holding: async () => r.apps,
    faceUrl: (panel) => 'http://127.0.0.1:3030/pump-face?via=direct&shape=' + panel.shape,
    makeLink: ({ onError }) => {
      const link = { open: true, onError, show: (j) => r.shown.push(j), close: async () => { link.open = false; } };
      r.links.push(link);
      return link;
    },
    makeBrowser: ({ url, onFrame, onError }) => {
      const b = { url, onFrame, onError, running: false, start: async () => { if (r.failStart) throw new Error(r.failStart); b.running = true; }, stop: () => { b.running = false; } };
      r.browsers.push(b);
      return b;
    },
    changed: () => { r.changes += 1; },
    clock: () => r.now,
    later: (fn, ms) => { const t = { fn, ms, live: true }; r.timers.push(t); return t; },
    cancel: (t) => { if (t) t.live = false; },
  };
  r.direct = Direct.createPumpDirect(deps);
  // Runs the timer armed last, as the clock would.
  r.next = async () => {
    const t = r.timers.filter((x) => x.live).pop();
    assert.ok(t, 'a check is armed');
    t.live = false;
    await t.fn();
  };
  r.armed = () => r.timers.filter((x) => x.live).map((x) => x.ms);
  r.drawing = () => r.browsers.filter((b) => b.running).length;
  return r;
}

test('on, with the screen plugged in and nothing holding it, Xenon draws and checks again in a few seconds', async () => {
  const r = rig();
  r.direct.refresh();
  await r.next();
  assert.deepEqual(r.direct.state(), { state: 'drawing', model: PANEL.model });
  assert.equal(r.drawing(), 1);
  assert.match(r.browsers[0].url, /via=direct&shape=round/);
  assert.deepEqual(r.armed(), [Direct.CHECK_MS]);
  r.browsers[0].onFrame(Buffer.from('frame'));
  assert.equal(r.shown.length, 1, 'a frame from the page reaches the screen');
  await r.next();
  assert.equal(r.browsers.length, 1, 'a check while drawing does not start a second browser');
});

test('iCUE opening makes Xenon step aside at the next check, and closing it gives the screen back', async () => {
  const r = rig();
  r.direct.refresh();
  await r.next();
  r.apps = ['iCUE'];
  await r.next();
  assert.deepEqual(r.direct.state(), { state: 'busy', app: 'iCUE' });
  assert.equal(r.drawing(), 0);
  assert.equal(r.links[0].open, false, 'the screen is let go');
  assert.deepEqual(r.armed(), [Direct.CHECK_MS]);
  r.apps = [];
  await r.next();
  assert.equal(r.direct.state().state, 'drawing');
  assert.equal(r.browsers.length, 2);
});

test('off draws nothing and stops looking; no screen plugged in looks again only once a minute', async () => {
  const off = rig({ on: false });
  off.direct.refresh();
  await off.next();
  assert.deepEqual(off.direct.state(), { state: 'off' });
  assert.equal(off.browsers.length, 0);
  assert.deepEqual(off.armed(), [], 'off arms no check');

  const none = rig({ plugged: [{ ...PUMP, productId: 0x3008, direct: false }] });
  none.direct.refresh();
  await none.next();
  assert.deepEqual(none.direct.state(), { state: 'none' });
  assert.deepEqual(none.armed(), [Direct.IDLE_MS]);
});

test('turning it off while it draws lets the screen go at once', async () => {
  const r = rig();
  r.direct.refresh();
  await r.next();
  r.on = false;
  r.direct.refresh();
  await r.next();
  assert.deepEqual(r.direct.state(), { state: 'off' });
  assert.equal(r.drawing(), 0);
  assert.equal(r.links[0].open, false);
});

test('a failure stops everything and waits longer each time, then a good run counts as working again', async () => {
  const r = rig({ failStart: 'no browser' });
  r.direct.refresh();
  await r.next();
  assert.deepEqual(r.direct.state(), { state: 'failed', reason: 'no browser' });
  assert.equal(r.links.at(-1).open, false, 'the link opened for it is closed');
  assert.deepEqual(r.armed(), [Direct.RETRY_MS[0]]);
  await r.next();
  assert.deepEqual(r.armed(), [Direct.RETRY_MS[1]]);
  await r.next();
  await r.next();
  assert.deepEqual(r.armed(), [Direct.RETRY_MS.at(-1)], 'the wait stops growing at the last step');

  r.failStart = null;
  await r.next();
  assert.equal(r.direct.state().state, 'drawing');
  r.browsers.at(-1).onError('hung');
  assert.equal(r.direct.state().state, 'failed');
  assert.deepEqual(r.armed(), [Direct.RETRY_MS.at(-1)], 'a failure soon after a start still waits long');

  r.now += 1;
  await r.next();
  r.now += Direct.HEALTHY_MS;
  await r.next();
  r.links.at(-1).onError(new Error('write failed'));
  assert.deepEqual(r.armed(), [Direct.RETRY_MS[0]], 'after a long good run the next failure waits short again');
});

test('a frame the screen refuses fails the run, and an old run that breaks late changes nothing', async () => {
  const r = rig();
  r.direct.refresh();
  await r.next();
  const old = r.browsers[0];
  r.links[0].show = () => { throw new Error('refused'); };
  old.onFrame(Buffer.from('x'));
  assert.deepEqual(r.direct.state(), { state: 'failed', reason: 'refused' });
  await r.next();
  assert.equal(r.direct.state().state, 'drawing');
  old.onError('closed');
  assert.equal(r.direct.state().state, 'drawing', 'the browser of a run already over is ignored');
});

test('stop lets the screen go and arms nothing more', async () => {
  const r = rig();
  r.direct.refresh();
  await r.next();
  await r.direct.stop();
  assert.equal(r.drawing(), 0);
  assert.equal(r.links[0].open, false);
  assert.deepEqual(r.armed(), []);
  r.direct.refresh();
  assert.deepEqual(r.armed(), [], 'nothing starts after stop');
});

test('the programs in the way are read from the process table, with a check that cannot run counting as busy', async () => {
  const table = (names) => ({ read: async () => names.map((name, pid) => ({ pid, name })) });
  const never = async () => { throw new Error('the fallback is not used while the table reads'); };
  assert.deepEqual(await createPumpApps({ platform: 'win32', table: table(['explorer', 'icue']), fallback: never })(PANEL), ['iCUE']);
  assert.deepEqual(await createPumpApps({ platform: 'win32', table: table(['explorer', 'icuelauncher']), fallback: never })(PANEL), []);
  assert.deepEqual(await createPumpApps({ platform: 'win32', table: { read: async () => null }, fallback: async () => ['unknown'] })(PANEL), ['unknown']);
  assert.deepEqual(await createPumpApps({ platform: 'linux', table: null, fallback: async () => ['openlinkhub'] })(PANEL), ['OpenLinkHub']);
  assert.deepEqual(await createPumpApps({ platform: 'darwin', table: null, fallback: never })(PANEL), [], 'no programs known there');
});

test('only the real Xenon draws on a real screen: not a copy on another port, not a test', () => {
  assert.equal(directAllowed({}, 3030), true);
  assert.equal(directAllowed({}, 3031), false);
  assert.equal(directAllowed({ NODE_TEST_CONTEXT: 'child-v8' }, 3030), false);
  assert.equal(directAllowed({ XENON_PUMP_DIRECT: '0' }, 3030), false);
  assert.equal(directAllowed({ XENON_PUMP_DIRECT: '1', NODE_TEST_CONTEXT: 'child-v8' }, 3031), true);
  const store = { peek: () => null, ready: async () => ({}) };
  assert.equal(startPumpDirect({ store, detect: async () => [], port: 3030, dataDir: os.tmpdir(), changed: () => {}, platform: 'darwin', env: { XENON_PUMP_DIRECT: '1' } }), null);
  assert.equal(startPumpDirect({ store, detect: async () => [], port: 3031, dataDir: os.tmpdir(), changed: () => {}, platform: 'win32', env: {} }), null);
});

test('the setting is on by default, changes only with a yes or no, and survives a restart and a backup', async (t) => {
  assert.equal(Model.normalize({}).direct, true);
  assert.equal(Model.normalize({ direct: false }).direct, false);
  assert.equal(Model.normalize({ direct: 'no' }).direct, true, 'anything but false is the default');
  assert.equal(Edit.setDirect(Model.normalize({}), true), null, 'no change, nothing written');
  assert.equal(Edit.setDirect(Model.normalize({}), false).model.direct, false);
  assert.equal(Edit.setDirect(Model.normalize({}), 'off').error, 'bad_direct');
  assert.ok(Model.VIAS.includes('direct'));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-pump-direct-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'uploads'));
  const store = createPumpStore({ dataDir: root });
  await store.update((m) => Edit.setDirect(m, false));
  assert.equal((await createPumpStore({ dataDir: root }).ready()).direct, false, 'read back after a restart');

  const backup = createPumpBackup({ store, dir: path.join(root, 'uploads'), changed: () => {} });
  const saved = await backup.save();
  assert.equal(saved.direct, false);
  await store.update((m) => Edit.setDirect(m, true));
  await backup.restore(saved);
  assert.equal(store.peek().direct, false, 'a backup brings the choice back');
  await backup.restore({ v: 1, screens: {} });
  assert.equal(store.peek().direct, false, 'an older backup without it keeps the current choice');
});
