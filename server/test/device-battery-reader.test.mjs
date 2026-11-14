// The safety around device reads: a separate process, devices left out after they crash
// it, the switch that stops asking, what the OS needs, and the macOS backend on a stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import './keep-loop-alive.mjs';

const require = createRequire(import.meta.url);
const { createGuard, keyOf } = require('../device-battery/guard.js');
const { createReader } = require('../device-battery/index.js');
const { accessFor, udevRule } = require('../device-battery/access.js');
const { createHidDarwin, outgoing } = require('../hid/hid-darwin.js');
const { createIoKit } = require('../hid/iokit.js');
const { readDongles } = require('../device-battery/darwin.js');
const { createBatteryMonitor } = require('../battery.js');

const MOUSE = { vendorId: 0x3151, productId: 0x4011 };
const quiet = () => {};

function fakeChild(script) {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.send = (request, done) => {
    child.request = request;
    done();
    setImmediate(() => script(child));
  };
  return child;
}

test('guard: names the device while it is open and clears it after', async () => {
  const notes = [];
  const guard = createGuard({ note: (key) => notes.push(key) });
  const hid = guard.wrapHid({ open: async () => ({ close: async () => {} }) });
  const link = await hid.open(MOUSE);
  assert.deepEqual(notes, ['3151:4011']);
  await link.close();
  assert.deepEqual(notes, ['3151:4011', null]);
});

test('guard: a device left out is never opened', async () => {
  let opened = 0;
  const guard = createGuard({ skip: [keyOf(MOUSE)] });
  const hid = guard.wrapHid({ open: async () => { opened += 1; return {}; } });
  await assert.rejects(hid.open(MOUSE), /left out/);
  assert.equal(opened, 0);
});

test('guard: a refusal by the OS is remembered, any other failure is not', async () => {
  const guard = createGuard();
  const refused = guard.wrapHid({ open: async () => { throw new Error('no-permission'); } });
  const broken = guard.wrapReports(async () => { throw new Error('gone'); });
  await assert.rejects(broken([MOUSE]));
  assert.equal(guard.denied, false);
  await assert.rejects(refused.open(MOUSE));
  assert.equal(guard.denied, true);
});

test('reader: gives back what the process read', async () => {
  const start = () => fakeChild((c) => c.emit('message', { result: { devices: [{ name: 'A', percent: 5 }], denied: false } }));
  const out = await createReader({ start, platform: 'linux' }).read();
  assert.deepEqual(out, { available: true, devices: [{ name: 'A', percent: 5 }], asked: true, access: null });
});

test('reader: a crash on one device leaves it out for a day, the next reads go on', async () => {
  let time = 1000;
  const requests = [];
  let crash = true;
  const start = () => {
    const child = fakeChild((c) => {
      requests.push(c.request.skip);
      if (crash) {
        c.emit('message', { touching: '3151:4011' });
        c.emit('exit', null, 'SIGSEGV');
      } else {
        c.emit('message', { result: { devices: [], denied: false } });
      }
    });
    return child;
  };
  const warnings = [];
  const reader = createReader({ start, now: () => time, platform: 'win32', warn: (line) => warnings.push(line) });
  assert.equal((await reader.read()).available, false);
  assert.match(warnings[0], /device 3151:4011: the reader crashed \(SIGSEGV\), left out for a day/);
  crash = false;
  assert.equal((await reader.read()).available, true);
  assert.deepEqual(requests[1], ['3151:4011']);
  time += 24 * 60 * 60 * 1000;
  await reader.read();
  assert.deepEqual(requests[2], []);
});

test('reader: a read that never ends is killed and its device left out', async () => {
  const children = [];
  const start = () => {
    const child = fakeChild((c) => c.emit('message', { touching: 'ab:cd' }));
    children.push(child);
    return child;
  };
  // The limit must be longer than the stand-in takes to name its device, also on a busy machine:
  // with a few milliseconds the limit can win, and then there is no device to leave out.
  const reader = createReader({ start, limitMs: 250, platform: 'darwin', warn: quiet });
  await reader.read();
  assert.equal(children[0].killed, true);
  await reader.read();
  assert.deepEqual(children[1].request.skip, ['ab:cd']);
});

test('reader: a process that keeps dying with no device to blame pauses for an hour', async () => {
  let time = 0;
  let started = 0;
  const start = () => { started += 1; return fakeChild((c) => c.emit('exit', 1, null)); };
  const reader = createReader({ start, now: () => time, platform: 'linux', warn: quiet });
  for (let i = 0; i < 3; i += 1) await reader.read();
  await reader.read();
  assert.equal(started, 3);
  time += 60 * 60 * 1000;
  await reader.read();
  assert.equal(started, 4);
});

test('reader: a failure the read reports is a failure, not an empty list', async () => {
  const start = () => fakeChild((c) => c.emit('message', { error: 'boom' }));
  assert.equal((await createReader({ start, platform: 'linux', warn: quiet }).read()).available, false);
});

test('reader: an OS it has no backend for starts nothing', async () => {
  const start = () => assert.fail('nothing to start');
  assert.equal((await createReader({ start, platform: 'freebsd' }).read()).available, false);
});

test('reader: the OS refusing a dongle comes back as what to do about it', async () => {
  const start = () => fakeChild((c) => c.emit('message', { result: { devices: [], denied: true } }));
  assert.deepEqual((await createReader({ start, platform: 'darwin' }).read()).access, { kind: 'input-monitoring' });
  assert.equal((await createReader({ start, platform: 'linux' }).read()).access.kind, 'udev');
});

test('reader: a real process that dies does not touch this one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-'));
  const script = path.join(dir, 'dies.cjs');
  fs.writeFileSync(script, "process.once('message', () => { process.send({ touching: 'dead:beef' }, () => process.kill(process.pid, 'SIGKILL')); });");
  const reader = createReader({ start: () => fork(script, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }), platform: process.platform, warn: quiet });
  assert.equal((await reader.read()).available, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reader: the real child answers on this OS, asking nothing of any device', async () => {
  const out = await createReader().read({ ask: false });
  assert.equal(out.available, true);
  assert.equal(out.asked, false);
  assert.ok(Array.isArray(out.devices));
});

test('udev: one line, each vendor once, for the logged-in user only', () => {
  const rule = udevRule();
  assert.equal(rule.includes('\n'), false);
  assert.ok(rule.startsWith('KERNEL=="hidraw*", KERNELS=="') && rule.endsWith('", TAG+="uaccess"'));
  assert.ok(rule.includes('0003:3151:*'));
  assert.ok(rule.includes('0003:1532:*'));
  assert.equal(accessFor('win32'), null);
});

test('macOS: report id 0 is left out of what IOKit gets, a numbered one stays', () => {
  const plain = outgoing(Buffer.from([0x00, 0xF7]), 4);
  assert.equal(plain.id, 0);
  assert.deepEqual([...plain.data], [0xF7, 0, 0, 0]);
  const numbered = outgoing(Buffer.from([0x11, 0xFF]), 4);
  assert.equal(numbered.id, 0x11);
  assert.deepEqual([...numbered.data], [0x11, 0xFF, 0, 0]);
});

function fakeIo({ open = 0, properties = {}, pairs = [{ usagePage: 0xFFFF, usage: 2 }], reports = [] } = {}) {
  const sent = [];
  const events = [];
  return {
    sent,
    events,
    managerCreate: () => 1n,
    setMatchingAll: () => {},
    scheduleManager: () => {},
    runLoop: () => {},
    copyDevices: () => [0xABCn],
    numberProperty: (_, name) => ({ VendorID: 0x3151, ProductID: 0x4011, bInterfaceNumber: 2, MaxOutputReportSize: 8, MaxFeatureReportSize: 8, MaxInputReportSize: 8, ...properties })[name] ?? null,
    stringProperty: () => 'Akko 2.4G',
    usagePairs: () => pairs,
    deviceOpen: () => open,
    deviceClose: () => events.push('close'),
    setReport: (_, type, id, data) => { sent.push({ type, id, data: [...data] }); return 0; },
    getReport: (_, type, id, target) => { target[0] = 0x1C; return 0; },
    listen(device, bytes, onReport) {
      for (const r of reports) onReport(Buffer.from(r));
      return { stop: () => events.push('stop') };
    },
  };
}

test('macOS: each usage of an interface is listed, with its interface number', async () => {
  const io = fakeIo({ pairs: [{ usagePage: 1, usage: 6 }, { usagePage: 0xFFFF, usage: 2 }] });
  const infos = await createHidDarwin({ getApi: () => io }).list({ vendorIds: [0x3151] });
  assert.deepEqual(infos.map((i) => i.usagePage), [1, 0xFFFF]);
  assert.equal(infos[0].path, 'iokit:abc&mi_02');
  assert.equal(infos[0].product, 'Akko 2.4G');
  assert.deepEqual(await createHidDarwin({ getApi: () => io }).list({ vendorIds: [0x1038] }), []);
});

test('macOS: Input Monitoring off is reported as no-permission, so the UI can say it', async () => {
  const hid = createHidDarwin({ getApi: () => fakeIo({ open: 0xE00002E2 | 0 }) });
  const [info] = await hid.list({ vendorId: 0x3151 });
  await assert.rejects(hid.open(info), /no-permission/);
  await assert.rejects(hid.openReports([info]), /no-permission/);
});

test('macOS: a feature report keeps the numbering of the other systems', async () => {
  const io = fakeIo();
  const hid = createHidDarwin({ getApi: () => io });
  const [info] = await hid.list({ vendorId: 0x3151 });
  const link = await hid.open(info);
  await link.setFeature([0x00, 0xF7]);
  assert.deepEqual(io.sent[0], { type: 2, id: 0, data: [0xF7, 0, 0, 0, 0, 0, 0, 0] });
  const reply = await link.getFeature(0);
  assert.equal(reply[0], 0);
  assert.equal(reply[1], 0x1C);
  await link.close();
  await link.close();
  assert.deepEqual(io.events, ['close']);
});

test('macOS: input reports queue up, silence ends, and closing stops listening first', async () => {
  const io = fakeIo({ reports: [[0xB0, 0x01]] });
  const hid = createHidDarwin({ getApi: () => io });
  const [info] = await hid.list({ vendorId: 0x3151 });
  const link = await hid.openReports([info]);
  await link.write([0x06, 0x01]);
  assert.equal(io.sent[0].type, 1);
  assert.deepEqual([...(await link.read(50))], [0xB0, 0x01]);
  assert.equal(await link.read(5), null);
  await link.close();
  assert.deepEqual(io.events, ['stop', 'close']);
});

test('macOS: the table reads a real Akko reply through this backend', async () => {
  const io = fakeIo({ pairs: [{ usagePage: 0xFFFF, usage: 2 }] });
  io.getReport = (_, type, id, target) => { Buffer.from([0x00, 0x1C, 0x00, 0x00, 0x01, 0x01, 0x01]).copy(target); return 0; };
  const guard = createGuard();
  const hid = createHidDarwin({ getApi: () => io });
  const devices = await readDongles(hid, guard);
  assert.deepEqual(devices, [{ name: 'Akko 2.4G', percent: 28, charging: null, source: 'dongle' }]);
});

test('macOS: with Input Monitoring off the guard knows, and nothing is listed', async () => {
  const guard = createGuard();
  const hid = createHidDarwin({ getApi: () => fakeIo({ open: 0xE00002E2 | 0 }) });
  assert.deepEqual(await readDongles(hid, guard), []);
  assert.equal(guard.denied, true);
});

function fakeFn(overrides = {}) {
  return {
    inputCallback: 'cb',
    stringCreate: (_, text) => BigInt(text.length),
    getTypeId: () => 1,
    numberTypeId: () => 1,
    stringTypeId: () => 2,
    numberValue: (_, __, out) => { out[0] = 42; return true; },
    stringValue: () => true,
    runLoopCurrent: () => 7n,
    ...overrides,
  };
}

test('iokit: pointers of a set come back as they are, a missing set as none', () => {
  const fn = fakeFn({
    managerCopy: (m) => (m === 1n ? 9n : 0n),
    setCount: () => 2,
    setValues: (_, values) => { values.writeBigUInt64LE(0xAAn, 0); values.writeBigUInt64LE(0xBBn, 8); },
  });
  const io = createIoKit({}, fn);
  assert.deepEqual(io.copyDevices(1n), [0xAAn, 0xBBn]);
  assert.deepEqual(io.copyDevices(2n), []);
});

test('iokit: a property of the wrong type or absent is null', () => {
  const absent = createIoKit({}, fakeFn({ deviceProperty: () => 0n }));
  assert.equal(absent.numberProperty(1n, 'VendorID'), null);
  const text = createIoKit({}, fakeFn({ deviceProperty: () => 5n, getTypeId: () => 2 }));
  assert.equal(text.numberProperty(1n, 'VendorID'), null);
  const number = createIoKit({}, fakeFn({ deviceProperty: () => 5n }));
  assert.equal(number.numberProperty(1n, 'VendorID'), 42);
});

function monitorWith(answers) {
  let reads = 0;
  const monitor = createBatteryMonitor({
    runScript: async () => ({ devices: [] }),
    lighting: { getBatteryLevels: async () => ({ ok: false }) },
    systemBattery: null,
    peripherals: async () => answers[Math.min(reads++, answers.length - 1)],
  });
  return { monitor, reads: () => reads };
}

test('switch off: what the dongles said goes at once, without waiting 12 hours', async () => {
  const mouse = { name: 'Akko', percent: 28, charging: null, source: 'dongle' };
  const { monitor } = monitorWith([
    { available: true, devices: [mouse], asked: true },
    { available: true, devices: [], asked: false },
  ]);
  assert.equal((await monitor.getDevices({ force: true })).devices.length, 1);
  monitor.peripheralsChanged();
  assert.equal((await monitor.getDevices()).devices.length, 0);
});

test('a PC with nothing on a dongle is not read every minute', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const { monitor, reads } = monitorWith([{ available: true, devices: [] }]);
  for (let i = 0; i < 5; i += 1) {
    await monitor.getDevices({ force: true });
    t.mock.timers.tick(61 * 1000);
  }
  await monitor.getDevices({ force: true });
  assert.equal(reads(), 5);
  t.mock.timers.tick(5 * 60 * 1000);
  await monitor.getDevices({ force: true });
  assert.equal(reads(), 6);
});

test('a mouse that went quiet is looked for again within a minute', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const mouse = { name: 'Akko', percent: 28, charging: null, source: 'dongle' };
  const { monitor, reads } = monitorWith([{ available: true, devices: [mouse] }, { available: true, devices: [] }]);
  await monitor.getDevices({ force: true });
  t.mock.timers.tick(5 * 60 * 1000 + 1);
  await monitor.getDevices({ force: true });
  t.mock.timers.tick(61 * 1000);
  await monitor.getDevices({ force: true });
  assert.equal(reads(), 3);
});

test('the payload says what the OS needs only when it needs something', async () => {
  const needed = monitorWith([{ available: true, devices: [], access: { kind: 'input-monitoring' } }]);
  assert.deepEqual((await needed.monitor.getDevices({ force: true })).access, { kind: 'input-monitoring' });
  const fine = monitorWith([{ available: true, devices: [], access: null }]);
  assert.equal('access' in (await fine.monitor.getDevices({ force: true })), false);
});
