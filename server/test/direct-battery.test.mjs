// The table of device protocols, against simulated devices built from real frames. The
// Akko reply was read from real hardware; the others are the captures public tools print.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { MODELS, byProduct, vendorIds } = require('../device-battery/brands/index.js');
const { productKey } = require('../device-battery/brands/ids.js');
const { createIo, fits, readDirect } = require('../device-battery/direct.js');
const headsets = require('../device-battery/brands/logitech-headsets.js');
const compx = require('../device-battery/brands/compx.js');
const { scaleUsage } = require('../device-battery/standard-windows.js');
const { decode: decodeGamepad } = require('../device-battery/gamepads-windows.js');
const { kernelDrives } = require('../device-battery/linux.js');
const { createOpenReports } = require('../hid/hid-reports-linux.js');
const { ASLEEP_MS, createBatteryMonitor, mergeSources } = require('../battery.js');

const noDelay = async () => {};
const bytes = (text) => Buffer.from(text.replace(/\s+/g, ''), 'hex');
const model = (vendorId, productId) => byProduct.get(productKey(vendorId, productId));

// Answers each report sent with the next reply queued, then stays silent.
function reportLink(replies = []) {
  const queue = replies.map((r) => (typeof r === 'string' ? bytes(r) : r));
  const sent = [];
  return { sent, write: async (b) => { sent.push(Buffer.from(b)); }, read: async () => queue.shift() ?? null, close: async () => {} };
}

function featureLink(replies = []) {
  const queue = replies.map((r) => (typeof r === 'string' ? bytes(r) : r));
  const sent = [];
  return { sent, setFeature: async (b) => { sent.push(Buffer.from(b)); }, getFeature: async () => queue.shift() ?? Buffer.alloc(65), close: async () => {} };
}

const reportIo = (link, size = 64) => createIo({ link, size, wait: noDelay });
const featureIo = (feature) => createIo({ feature, size: 65, wait: noDelay });

test('no device is in two models, and each model can read', () => {
  assert.equal(MODELS.reduce((n, m) => n + m.products.length, 0), byProduct.size);
  for (const m of MODELS) {
    assert.equal(typeof m.read, 'function', m.label);
    assert.ok(m.label && m.products.length, m.label);
  }
  assert.ok(vendorIds.includes(0x3151));
});

test('Akko: the keyboard charge from the reply of a real receiver', async () => {
  const link = featureLink(['00 00 1c 00 00 01 01 01']);
  assert.deepEqual(await model(0x3151, 0x4011).read(featureIo(link)), [{ percent: 28, charging: null }]);
  assert.deepEqual([...link.sent[0]], [0x00, 0xF7]);
});

test('receiver: a keyboard and a mouse both on are told apart', async () => {
  const link = featureLink(['00 01 32 46 00 00 01']);
  const found = await model(0x3151, 0x402D).read(featureIo(link));
  assert.deepEqual(found.map((d) => [d.percent, d.suffix]), [[50, 'keyboard'], [70, 'mouse']]);
});

test('receiver: a reply it has not filled yet is asked again, then given up', async () => {
  const link = featureLink(['00 00 00 00 00 00 00', '00 00 00 00 00 00 00', '00 00 00 00 00 00 00']);
  assert.deepEqual(await model(0x3151, 0x4011).read(featureIo(link)), []);
  assert.equal(link.sent.length, 3);
});

test('receiver: an offline slot and a level of 0 are no reading', async () => {
  assert.deepEqual(await model(0x3151, 0x4011).read(featureIo(featureLink(['00 00 1c 00 01 01 01']))), []);
  assert.deepEqual(await model(0x3151, 0x4011).read(featureIo(featureLink(['00 00 00 00 00 01 01']))), []);
});

test('Logitech headset: millivolts on the curve, and charging', async () => {
  const link = reportLink(['11 ff 06 0d 0f 9a 03']);
  assert.deepEqual(await model(0x046D, 0x0AAA).read(reportIo(link, 20)), [{ percent: 76, charging: true }]);
  assert.deepEqual([...link.sent[0].subarray(0, 4)], [0x11, 0xFF, 0x06, 0x0D]);
  assert.equal(link.sent[0].length, 20);
});

test('Logitech headset: the error frame of a real dongle with the headset off is no reading', async () => {
  assert.deepEqual(await model(0x046D, 0x0AAA).read(reportIo(reportLink(['11 ff ff 06 0d 06']), 20)), []);
});

test('Logitech headset: the curve ends where the source ends it', () => {
  assert.equal(headsets.percentFromCurve(headsets.CURVE_PRO, 4200), 100);
  assert.equal(headsets.percentFromCurve(headsets.CURVE_PRO, 3830), 50);
  assert.equal(headsets.percentFromCurve(headsets.CURVE_PRO, 3000), null);
});

test('Compx: the frame adds up and a real reply decodes', async () => {
  assert.equal(compx.frame(0x04)[16], 0x49);
  assert.equal(compx.frame(0x03)[16], 0x4A);
  const status = Buffer.alloc(17);
  status.set([0x08, 0x03, 0, 0, 0, 0, 0x01]);
  status[16] = (0x55 - 0x08 - 0x03 - 0x01) & 0xFF;
  const reply = bytes('08 04 00 00 00 02 5f 00 10 00 00 00 00 00 00 00 d8');
  assert.deepEqual(await model(0x3554, 0xF508).read(reportIo(reportLink([status, reply]), 17)), [{ percent: 95, charging: null }]);
});

test('Compx: a mouse not on its dongle, and a frame with a bad sum, are no reading', async () => {
  const away = Buffer.alloc(17);
  away.set([0x08, 0x03]);
  away[16] = (0x55 - 0x08 - 0x03) & 0xFF;
  assert.deepEqual(await model(0x3554, 0xF508).read(reportIo(reportLink([away]), 17)), []);
  const bad = bytes('08 03 00 00 00 00 01 00 00 00 00 00 00 00 00 00 00');
  assert.deepEqual(await model(0x3554, 0xF508).read(reportIo(reportLink([bad]), 17)), []);
});

test('Corsair: a value counts when two answers agree', async () => {
  const level = '01 02 00 26 02';
  const charge = '01 02 00 02 00';
  const link = reportLink([level, level, charge, charge]);
  assert.deepEqual(await model(0x1B1C, 0x1B7F).read(reportIo(link)), [{ percent: 55, charging: false }]);
  assert.deepEqual(link.sent.map((b) => [...b.subarray(0, 4)]), [
    [0x00, 0x09, 0x02, 0x0F], [0x00, 0x09, 0x02, 0x0F], [0x00, 0x09, 0x02, 0x10], [0x00, 0x09, 0x02, 0x10],
  ]);
});

test('Corsair: two different answers may be iCUE talking, so there is no reading', async () => {
  assert.deepEqual(await model(0x1B1C, 0x1B7F).read(reportIo(reportLink(['01 02 00 26 02', '01 02 00 2c 01']))), []);
});

test('Corsair headset: 450 tenths is 45 percent', async () => {
  const level = '01 01 02 00 c2 01';
  const charge = '01 01 02 00 01 00';
  assert.deepEqual(await model(0x1B1C, 0x0A97).read(reportIo(reportLink([level, level, charge, charge]))), [{ percent: 45, charging: true }]);
});

test('SteelSeries: an Aerox gauge and its charging bit', async () => {
  assert.deepEqual(await model(0x1038, 0x1838).read(reportIo(reportLink(['d2 8b']))), [{ percent: 50, charging: true }]);
});

test('SteelSeries: offline Nova and a live one', async () => {
  const nova = model(0x1038, 0x2269);
  assert.deepEqual(await nova.read(reportIo(reportLink(['b0 02 00 40 00']))), []);
  assert.deepEqual(await nova.read(reportIo(reportLink(['b0 03 00 40 01']))), [{ percent: 64, charging: true }]);
});

test('HyperX Cloud III S: the read frame keeps byte 3 at 1, which 0 would make a write', async () => {
  const link = reportLink(['0c 02 03 01 00 06 59', '0c 02 03 01 00 48 00']);
  assert.deepEqual(await model(0x03F0, 0x02CC).read(reportIo(link)), [{ percent: 89, charging: false }]);
  for (const frame of link.sent) assert.equal(frame[3], 0x01);
});

test('Glorious: a mouse asleep says so, an awake one gives its charge', async () => {
  const mouse = model(0x258A, 0x2033);
  assert.deepEqual(await mouse.read(featureIo(featureLink(['00 a4 00 00 02 00 83 00 00']))), []);
  assert.deepEqual(await mouse.read(featureIo(featureLink(['00 a1 00 00 02 00 83 00 4b']))), [{ percent: 75, charging: null }]);
});

test('PlayStation: nothing is sent, only input is read', async () => {
  const report = Buffer.alloc(78);
  report[0] = 0x31;
  report[54] = 0x15;
  const link = reportLink([report]);
  assert.deepEqual(await model(0x054C, 0x0CE6).read(reportIo(link)), [{ percent: 55, charging: true }]);
  assert.equal(link.sent.length, 0);
});

test('PlayStation: the short Bluetooth report carries no battery and is left alone', async () => {
  const short = Buffer.alloc(10);
  short[0] = 0x01;
  assert.deepEqual(await model(0x054C, 0x0CE6).read(reportIo(reportLink([short]))), []);
});

test('no model sends a frame known to change a device', async () => {
  const sent = [];
  await Promise.all(MODELS.map((m) => {
    const link = { write: async (b) => sent.push(Buffer.from(b)), read: async () => null };
    const feature = { setFeature: async (b) => sent.push(Buffer.from(b)), getFeature: async () => Buffer.alloc(65) };
    return m.read(createIo({ link, feature, size: 64, wait: noDelay })).catch(() => {});
  }));
  assert.ok(sent.length > MODELS.length / 2);
  const payload = (b) => b.subarray(b[0] === 0 ? 1 : 0);
  for (const frame of sent) {
    const p = payload(frame);
    assert.notDeepEqual([...p.subarray(0, 3)], [0x08, 0x01, 0x03], 'Corsair software mode');
    assert.notDeepEqual([...p.subarray(0, 2)], [0x08, 0x06], 'Glorious reset');
    assert.notEqual(p[0], 0x75, 'Sinowealth firmware mode');
    assert.notEqual(p[0], 0xE1, 'Razer remote mode');
  }
});

test('a report is padded to what the collection declares', async () => {
  const link = reportLink();
  await createIo({ link, size: 20 }).ask([0x11, 0xFF], () => true, 1);
  assert.equal(link.sent[0].length, 20);
});

test('the 0 Windows puts before a report with no id is taken off, on Windows only', async () => {
  const seen = [];
  const accept = (r) => { seen.push(r[0]); return true; };
  await createIo({ link: reportLink(['00 b0 01']), size: 8, leadingZero: true }).listen(accept, 5);
  await createIo({ link: reportLink(['00 b0 01']), size: 8, leadingZero: false }).listen(accept, 5);
  assert.deepEqual(seen, [0xB0, 0x00]);
});

test('a collection fits by page, usage and USB interface', () => {
  const m = { page: 0xFF43, usage: 0x0202 };
  assert.equal(fits(m, { path: 'x', usagePage: 0xFF43, usage: 0x0202, outputLength: 20 }), true);
  const nordic = model(0x1915, 0xAE1C);
  assert.equal(fits(nordic, { path: 'x', usagePage: 0xFFA0, product: 'Ninjutso Sora V2', featureLength: 33 }), true);
  assert.equal(fits(nordic, { path: 'x', usagePage: 0xFFA0, product: 'Someone else nRF dongle', featureLength: 33 }), false);
  assert.equal(fits(nordic, { path: 'x', usagePage: 0xFFA0, featureLength: 33 }), false);
  assert.equal(fits(m, { path: 'x', usagePage: 0xFF43, usage: 1, outputLength: 20 }), false);
  assert.equal(fits(m, { path: 'x', usagePage: 0xFF43, usage: 0x0202, outputLength: 0 }), false);
  assert.equal(fits({ usbInterface: 3 }, { path: 'hid#vid_1038&pid_1838&mi_02', outputLength: 64 }), false);
  assert.equal(fits({ usbInterface: 3 }, { path: 'hid#vid_1038&pid_1838&mi_03', outputLength: 64 }), true);
  assert.equal(fits({ usbInterface: 3 }, { path: '/dev/hidraw4' }), true, 'hidraw paths say no interface');
});

const akko = { path: 'a', vendorId: 0x3151, productId: 0x4011, usagePage: 0xFFFF, usage: 2, featureLength: 65, product: 'Akko 2.4G Wireless Keyboard' };

test('readDirect: names a device by what it calls itself and marks it a dongle', async () => {
  const transport = { list: async () => [akko], open: async () => featureLink(['00 00 1c 00 00 01 01']) };
  assert.deepEqual(await readDirect(transport), [{ name: 'Akko 2.4G Wireless Keyboard', percent: 28, charging: null, source: 'dongle' }]);
});

test('readDirect: a device outside the table is never opened', async () => {
  let opened = 0;
  const stranger = { ...akko, productId: 0x9999 };
  const transport = { list: async () => [stranger], open: async () => { opened += 1; return featureLink(); }, openReports: async () => { opened += 1; return reportLink(); }, peers: (i) => [i] };
  assert.deepEqual(await readDirect(transport), []);
  assert.equal(opened, 0);
});

test('readDirect: one device that fails leaves the others', async () => {
  const broken = { ...akko, path: 'b', productId: 0x4014 };
  const transport = {
    list: async () => [broken, akko],
    open: async (info) => { if (info.path === 'b') throw new Error('refused'); return featureLink(['00 00 1c 00 00 01 01']); },
  };
  assert.equal((await readDirect(transport)).length, 1);
});

test('readDirect: a device that answered is not asked on its other collections', async () => {
  let opened = 0;
  const glorious = { path: 'g1', vendorId: 0x258A, productId: 0x2033, usagePage: 0xFF02, usage: 1, featureLength: 65, product: 'Model O 2' };
  const transport = {
    list: async () => [glorious, { ...glorious, path: 'g2' }],
    open: async () => { opened += 1; return featureLink(['00 a1 00 00 02 00 83 00 4b']); },
  };
  assert.equal((await readDirect(transport)).length, 1);
  assert.equal(opened, 1);
});

test('readDirect: a device with nowhere to hear a reply is not asked', async () => {
  let opened = 0;
  const silent = { path: 's', vendorId: 0x046D, productId: 0x0AAA, usagePage: 0xFF43, usage: 0x0202, inputLength: 0, outputLength: 20 };
  const transport = { list: async () => [silent], peers: (i) => [i], openReports: async () => { opened += 1; return reportLink(); } };
  await readDirect(transport);
  assert.equal(opened, 0);
});

test('standard usage: scaled to the device\'s own limits', () => {
  assert.equal(scaleUsage(50, 0, 100), 50);
  assert.equal(scaleUsage(127, 0, 255), 50);
  assert.equal(scaleUsage(300, 0, 255), null);
  assert.equal(scaleUsage(70, 0, 0), 70, 'no limits means percent');
  assert.equal(scaleUsage(170, 0, 0), null);
});

test('Xbox: a wired pad has no battery, a wireless one gives a level', () => {
  assert.equal(decodeGamepad({ BatteryType: 1, BatteryLevel: 3 }), null);
  assert.equal(decodeGamepad({ BatteryType: 0, BatteryLevel: 0 }), null);
  assert.equal(decodeGamepad({ BatteryType: 2, BatteryLevel: 2 }), 66);
  assert.equal(decodeGamepad({ BatteryType: 3, BatteryLevel: 3 }), 100);
});

test('linux: a device with a kernel driver is not asked a second time', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hidraw-'));
  fs.mkdirSync(path.join(root, 'hidraw3', 'device', 'power_supply', 'hid-battery'), { recursive: true });
  fs.mkdirSync(path.join(root, 'hidraw4', 'device'), { recursive: true });
  assert.equal(await kernelDrives({ path: '/dev/hidraw3' }, root), true);
  assert.equal(await kernelDrives({ path: '/dev/hidraw4' }, root), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('linux reports: waits through EAGAIN and returns what came', async () => {
  let calls = 0;
  const file = {
    read: async (buffer) => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('again'), { code: 'EAGAIN' });
      buffer[0] = 0xB0;
      return { bytesRead: 1 };
    },
    write: async () => {},
    close: async () => {},
  };
  const link = await createOpenReports({ openNode: async () => file, wait: noDelay })([{ path: '/dev/hidraw1' }]);
  assert.deepEqual([...(await link.read(1000))], [0xB0]);
  await link.close();
});

test('linux reports: silence ends at the deadline, and a refused node is explained', async () => {
  const file = { read: async () => { throw Object.assign(new Error('again'), { code: 'EAGAIN' }); }, close: async () => {} };
  const link = await createOpenReports({ openNode: async () => file, wait: noDelay })([{ path: '/dev/hidraw1' }]);
  assert.equal(await link.read(5), null);
  const denied = createOpenReports({ openNode: async () => { throw Object.assign(new Error('no'), { code: 'EACCES' }); } });
  await assert.rejects(denied([{ path: '/dev/hidraw1' }]), /no-permission/);
});

test('a device on a dongle keeps its last charge while it sleeps', () => {
  const now = 1000000000;
  const map = mergeSources([], [], new Map(), now, [{ name: 'Akko', percent: 28, charging: null, source: 'dongle' }]);
  assert.equal(map.get('akko').source, 'dongle');
  assert.ok(mergeSources([], [], map, now + ASLEEP_MS - 1, []).has('akko'));
  assert.equal(mergeSources([], [], map, now + ASLEEP_MS + 1, []).has('akko'), false);
});

test('with iCUE reporting, a Corsair device is not listed a second time from its dongle', async () => {
  const monitor = createBatteryMonitor({
    runScript: async () => ({ devices: [] }),
    lighting: { getBatteryLevels: async () => ({ devices: [{ name: 'DARK CORE RGB PRO SE', percent: 60 }] }) },
    systemBattery: null,
    peripherals: async () => ({ available: true, devices: [
      { name: 'CORSAIR SLIPSTREAM', percent: 60, charging: false, source: 'dongle', vendor: 'corsair' },
      { name: 'Akko', percent: 28, charging: null, source: 'dongle' },
    ] }),
  });
  const { devices } = await monitor.getDevices({ force: true });
  assert.deepEqual(devices.map((d) => d.name).sort(), ['Akko', 'DARK CORE RGB PRO SE']);
});
