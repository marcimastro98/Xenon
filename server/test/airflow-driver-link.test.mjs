// Airflow's iCUE LINK driver (server/airflow/driver-link.js) on a stand-in hub, and
// the check for programs that talk to the hub (link-busy.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeLinkHub, deviceEntry, EMPTY } from './airflow-link-fake.mjs';

const require = createRequire(import.meta.url);
const { createLinkDriver, standIn, STAND_IN, YIELD_MS, OWN_SILENCE_MS, FORGIVE_MS } = require('../airflow/driver-link.js');
const { createLinkBusy } = require('../airflow/link-busy.js');
const { mergePolls } = require('../airflow/sense.js');

const IFACES = [
  { vendorId: 0x1b1c, productId: 0x0c3f, usagePage: 0xff42, usage: 1, outputLength: 513, path: 'cmd' },
  { vendorId: 0x1b1c, productId: 0x0c3f, usagePage: 0xff42, usage: 2, outputLength: 0, path: 'events' },
];

/** A driver on a stand-in hub: pump on 1, fan on 2, an empty slot, a screen on 4. */
function rig({ busy = [], wanted = true, hub = fakeLinkHub({ channels: [deviceEntry(0x11, 5, 'PUMPID'), deviceEntry(0x0f, 0, 'FANID'), EMPTY, deviceEntry(0x06, 0, 'LCDID')], rpm: [null, 2400, 1200, null, null], temps: [368, 404, null, null, null] }) } = {}) {
  const opened = [];
  const state = { wanted, busy, hub, opened, list: IFACES, t: 1000 };
  const driver = createLinkDriver({
    hid: { list: async () => state.list },
    openReports: async (ifaces) => { opened.push(ifaces.map((i) => i.path)); return hub.link; },
    leadingZero: true,
    busy: async () => state.busy,
    wanted: () => state.wanted,
    now: () => (state.t += 10),
  });
  return { driver, state };
}

test('the prudent curve: fans from 40 % at a cool liquid to full where it is too hot; the pump high', () => {
  assert.equal(standIn('fan', 30), STAND_IN.fanLow);
  assert.equal(standIn('fan', STAND_IN.coolC), STAND_IN.fanLow);
  assert.equal(standIn('fan', (STAND_IN.coolC + STAND_IN.fullC) / 2), 70);
  // Full where the safety layer calls the liquid too hot, never sooner.
  assert.equal(STAND_IN.fullC, require('../airflow/limits.js').COMPONENTS.liquid.full);
  assert.equal(standIn('fan', STAND_IN.fullC), 100);
  assert.equal(standIn('fan', 60), 100);
  assert.equal(standIn('pump', 30), STAND_IN.pump);
  assert.equal(standIn('pump', STAND_IN.fullC), 100);
  // No liquid reading: everything at full.
  assert.equal(standIn('fan', null), 100);
  assert.equal(standIn('pump', NaN), 100);
});

test('available only when the hub is there, wanted, and no other program talks to it', async () => {
  const { driver, state } = rig();
  assert.deepEqual(await driver.available(), { ok: true, why: null });
  state.busy = ['CorsairService'];
  assert.deepEqual(await driver.available(), { ok: false, why: 'vendor-app' });
  state.busy = [];
  state.wanted = false;
  assert.deepEqual(await driver.available(), { ok: false, why: 'link-off' });
  state.list = [];
  // No hub: said even while not wanted, so the menu hides the switch.
  assert.deepEqual(await driver.available(), { ok: false, why: 'no-hub' });
  state.wanted = true;
  assert.deepEqual(await driver.available(), { ok: false, why: 'no-hub' });
});

test('a poll takes the hub, opens the command interface only, and finds its fan and pump', async () => {
  const { driver, state } = rig();
  const p = await driver.poll();
  assert.deepEqual(state.opened, [['cmd']]);
  assert.equal(state.hub.mode, 'software');
  const ch = driver.channels();
  assert.deepEqual(ch.map((c) => [c.id, c.kind, c.name, c.rpm]), [['link:hub:ch-1', 'pump', 'TITAN AIO pump', 2400], ['link:hub:ch-2', 'fan', 'RX RGB fan', 1200]]);
  assert.ok(ch.every((c) => c.source === 'hub' && c.controllable && c.restorable));
  // The pump's temperature is the liquid's; the hub's own (entry 0) is not.
  assert.equal(p.temps.liquid.value, 40.4);
  // Each channel's own speed, as a reading the fan check pairs like any other.
  assert.deepEqual(p.tachs, { 'link:hub:rpm-1': 2400, 'link:hub:rpm-2': 1200 });
  assert.deepEqual(ch.map((c) => [c.tach, c.settleMs]), [['link:hub:rpm-1', 40000], ['link:hub:rpm-2', 40000]]);
  const snap = mergePolls([driver], [p], 5000);
  assert.deepEqual(snap.found.map((f) => f.driver), ['link', 'link']);
  assert.equal(snap.temps.liquid.value, 40.4);
});

test('watching puts every channel on the prudent curve; driving sets what the safety layer said', async () => {
  const { driver, state } = rig();
  await driver.poll();
  await driver.hello();
  assert.deepEqual([...state.hub.speeds], [[1, STAND_IN.pump], [2, standIn('fan', 40.4)]]);
  await driver.apply({ 'link:hub:ch-1': { action: 'set', duty: 60 }, 'link:hub:ch-2': { action: 'set', duty: 35 } });
  assert.deepEqual([...state.hub.speeds], [[1, 60], [2, 35]]);
  await driver.poll();
  assert.deepEqual(driver.channels().map((c) => [c.duty, c.held]), [[60, 'set'], [35, 'set']]);
  // A channel handed back goes on the curve; the other keeps its speed.
  await driver.apply({ 'link:hub:ch-1': { action: 'set', duty: 60 }, 'link:hub:ch-2': { action: 'firmware', why: 'stall' } });
  assert.deepEqual([...state.hub.speeds], [[1, 60], [2, standIn('fan', 40.4)]]);
});

test('a pump is never set under its floor, and a speed is written only when it changes', async () => {
  const { driver, state } = rig();
  await driver.poll();
  await driver.apply({ 'link:hub:ch-1': { action: 'set', duty: 10 }, 'link:hub:ch-2': { action: 'set', duty: 0 } });
  assert.deepEqual([...state.hub.speeds], [[1, 50], [2, 0]]);
  const writes = () => state.hub.log.filter((l) => l.startsWith('06')).length;
  const before = writes();
  await driver.apply({ 'link:hub:ch-1': { action: 'set', duty: 10 }, 'link:hub:ch-2': { action: 'set', duty: 0 } });
  assert.equal(writes(), before);
});

test('release gives the hub back to its saved profile; the next poll takes it again', async () => {
  const { driver, state } = rig();
  await driver.poll();
  await driver.apply({ 'link:hub:ch-2': { action: 'set', duty: 30 } });
  await driver.release();
  assert.equal(state.hub.mode, 'hardware');
  assert.equal(state.hub.closed, true);
  await driver.poll();
  assert.equal(state.hub.mode, 'software');
});

test('not wanted: a poll leaves the hub alone', async () => {
  const { driver, state } = rig({ wanted: false });
  assert.equal(await driver.poll(), null);
  assert.deepEqual(state.opened, []);
  assert.equal(state.hub.mode, 'hardware');
});

test('a hub that stops answering ends the poll empty, and the next poll starts over', async () => {
  const hub = fakeLinkHub();
  const { driver, state } = rig({ hub });
  hub.silent = true;
  const p = await driver.poll();
  assert.equal(p, null);
  assert.deepEqual(driver.channels(), []);
  hub.silent = false;
  assert.ok(await driver.poll());
  assert.equal(state.opened.length, 2);
});

test('busy on Windows: iCUE itself, not its services; a failed check counts as busy', async () => {
  const calls = [];
  const run = (tasks) => async (file, args) => { calls.push(file); return tasks; };
  const none = createLinkBusy({ platform: 'win32', run: run({ ok: true, out: '"explorer.exe","1"\n"CorsairService.exe","90"\n' }) });
  assert.deepEqual(await none(), []);
  const icue = createLinkBusy({ platform: 'win32', run: run({ ok: true, out: '"iCUE.exe","37"\n' }) });
  assert.deepEqual(await icue(), ['iCUE.exe']);
  const broken = createLinkBusy({ platform: 'win32', run: run({ ok: false, out: '' }) });
  assert.deepEqual(await broken(), ['unknown']);
  assert.ok(calls.every((f) => f === 'tasklist'));
});

test('another program takes the hub back twice: Xenon gives it back and keeps off for a while', async () => {
  const { driver, state } = rig();
  await driver.poll();
  await driver.apply({ 'link:hub:ch-2': { action: 'set', duty: 35 } });
  // Put back in hardware mode a second after Xenon's last command: not the hub's own timeout.
  // With no program running the first time is let pass; the second time is a program at work.
  state.hub.mode = 'hardware';
  state.t += 1000;
  assert.ok(await driver.poll());
  assert.equal(state.hub.mode, 'software');
  state.hub.mode = 'hardware';
  state.t += 1000;
  assert.equal(await driver.poll(), null);
  assert.equal(state.hub.mode, 'hardware');
  assert.equal(state.hub.closed, true);
  assert.deepEqual(driver.channels(), []);
  assert.deepEqual(await driver.available(), { ok: false, why: 'vendor-app' });
  assert.equal(await driver.poll(), null);
  assert.equal(state.opened.length, 1);
  state.t += YIELD_MS;
  assert.deepEqual(await driver.available(), { ok: true, why: null });
  assert.ok(await driver.poll());
  assert.equal(state.hub.mode, 'software');
});

test('iCUE took the hub back: Xenon keeps off while it runs and takes the hub again at the first check after it quits', async () => {
  const { driver, state } = rig();
  await driver.poll();
  await driver.apply({ 'link:hub:ch-2': { action: 'set', duty: 35 } });
  state.busy = ['iCUE.exe'];
  state.hub.mode = 'hardware';
  state.t += 1000;
  assert.equal(await driver.poll(), null);
  assert.deepEqual(await driver.available(), { ok: false, why: 'vendor-app' });
  // A check that cannot run is still a doubt: the hub stays alone.
  state.busy = ['unknown'];
  assert.deepEqual(await driver.available(), { ok: false, why: 'vendor-app' });
  // iCUE closed a minute later: no five minutes of dark fans and lights.
  state.busy = [];
  state.t += 60000;
  assert.deepEqual(await driver.available(), { ok: true, why: null });
  assert.ok(await driver.poll());
  assert.equal(state.hub.mode, 'software');
});

test('taken back by a program the check cannot name: the whole step aside, even with nothing in the way', async () => {
  const { driver, state } = rig();
  await driver.poll();
  state.busy = ['unknown'];
  state.hub.mode = 'hardware';
  state.t += 1000;
  assert.equal(await driver.poll(), null);
  state.busy = [];
  state.t += 60000;
  assert.deepEqual(await driver.available(), { ok: false, why: 'vendor-app' });
  assert.equal(await driver.poll(), null);
  state.t += YIELD_MS;
  assert.deepEqual(await driver.available(), { ok: true, why: null });
});

test('iCUE quits after the last look at the running apps and leaves the hub in hardware mode: Xenon keeps it, at once', async () => {
  const { driver, state } = rig();
  await driver.poll();
  await driver.apply({ 'link:hub:ch-2': { action: 'set', duty: 35 } });
  state.hub.mode = 'hardware';
  state.t += 1000;
  assert.ok(await driver.poll());
  assert.equal(state.hub.mode, 'software');
  assert.notEqual(state.hub.closed, true);
  assert.ok(driver.channels().length > 0);
  assert.deepEqual(await driver.available(), { ok: true, why: null });
  // Let pass once in FORGIVE_MS: a second change within it is a program at work.
  state.t += FORGIVE_MS - 5000;
  assert.ok(await driver.poll());
  state.hub.mode = 'hardware';
  state.t += 1000;
  assert.equal(await driver.poll(), null);
  assert.deepEqual(await driver.available(), { ok: false, why: 'vendor-app' });
});

test('a hub back in hardware mode after a long silence went back by itself: taken again, no step aside', async () => {
  const { driver, state } = rig();
  await driver.poll();
  state.hub.mode = 'hardware';
  state.t += OWN_SILENCE_MS + 1000;
  assert.ok(await driver.poll());
  assert.equal(state.hub.mode, 'software');
  assert.deepEqual(await driver.available(), { ok: true, why: null });
});

test('busy on Linux: an OpenLinkHub process; a /proc that cannot be read counts as busy', async () => {
  const files = { '/proc': ['1', '22', 'self'], '/proc/1/comm': 'systemd\n', '/proc/22/comm': 'OpenLinkHub\n' };
  const fsp = {
    readdir: async (p) => { if (!files[p]) throw new Error('no'); return files[p]; },
    readFile: async (p) => { if (files[p.replaceAll('\\', '/')] == null) throw new Error('no'); return files[p.replaceAll('\\', '/')]; },
  };
  assert.deepEqual(await createLinkBusy({ platform: 'linux', fsp, procRoot: '/proc' })(), ['OpenLinkHub']);
  files['/proc/22/comm'] = 'bash\n';
  assert.deepEqual(await createLinkBusy({ platform: 'linux', fsp, procRoot: '/proc' })(), []);
  assert.deepEqual(await createLinkBusy({ platform: 'linux', fsp, procRoot: '/nope' })(), ['unknown']);
  assert.deepEqual(await createLinkBusy({ platform: 'darwin' })(), []);
});

test('an AIO kit (one pump, up to three fans) puts its fans on the radiator; a longer chain guesses nothing', async () => {
  const kit = rig();
  await kit.driver.poll();
  assert.deepEqual(kit.driver.channels().map((c) => [c.kind, c.place ?? null]), [['pump', null], ['fan', 'radiator']]);
  const fan = (n) => deviceEntry(0x0f, 0, `FAN${n}`);
  const long = rig({ hub: fakeLinkHub({ channels: [deviceEntry(0x11, 5, 'PUMPID'), fan(1), fan(2), fan(3), fan(4)], rpm: [null, 2400, 1200, 1200, 1200, 1200], temps: [368, 404, null, null, null, null] }) });
  await long.driver.poll();
  assert.deepEqual(long.driver.channels().map((c) => c.place ?? null), [null, null, null, null, null]);
  const noPump = rig({ hub: fakeLinkHub({ channels: [fan(1), fan(2)], rpm: [null, 1200, 1200], temps: [368, null, null] }) });
  await noPump.driver.poll();
  assert.deepEqual(noPump.driver.channels().map((c) => c.place ?? null), [null, null]);
});

test('no longer wanted while held: the next poll gives the hub back to its profile at once', async () => {
  const { driver, state } = rig();
  await driver.poll();
  assert.equal(state.hub.mode, 'software');
  state.wanted = false;
  assert.equal(await driver.poll(), null);
  assert.equal(state.hub.mode, 'hardware');
  assert.equal(state.hub.closed, true);
});

test("the liquid is the pump's reading, never a fan's or the hub's own, wherever the pump sits", async () => {
  const hub = fakeLinkHub({ channels: [deviceEntry(0x0f, 0, 'FANID'), deviceEntry(0x11, 5, 'PUMPID')], rpm: [null, 1200, 2400], temps: [368, 300, 404] });
  const { driver } = rig({ hub });
  const p = await driver.poll();
  assert.equal(p.liquid, 40.4);
  assert.equal(p.temps.liquid.value, 40.4);
});
