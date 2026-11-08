// The OS backends and the monitor around them: sysfs and ioreg against fixtures, and
// a dongle source that must never be polled as often as the others.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readPowerSupplies, sourceOf } = require('../device-battery/linux.js');
const { parseIoreg } = require('../device-battery/darwin.js');
const { interfaceKey, groupByInterface } = require('../device-battery/windows.js');
const { readRazerDevices } = require('../device-battery/razer.js');
const { ASLEEP_MS, createBatteryMonitor, mergeSources, PERIPHERAL_TTL_MS, STALE_MS, TTL_MS } = require('../battery.js');

function powerSupplies(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-power-'));
  for (const [entry, attributes] of Object.entries(entries)) {
    fs.mkdirSync(path.join(root, entry));
    for (const [name, value] of Object.entries(attributes)) fs.writeFileSync(path.join(root, entry, name), value + '\n');
  }
  return root;
}

test('linux: any brand with a kernel driver is listed, the PC pack is not', async () => {
  const root = powerSupplies({
    'hidpp_battery_0': { scope: 'Device', model_name: 'PRO X 2', capacity: '99', status: 'Discharging' },
    'hid-steelseries-battery': { scope: 'Device', model_name: 'Aerox 3', capacity: '41', status: 'Charging' },
    'hid-keyboard-battery': { scope: 'Device', model_name: 'Keyboard', capacity: '70', status: 'Full' },
    BAT0: { model_name: 'Laptop', capacity: '50', status: 'Discharging' },
    AC: { scope: 'System', online: '1' },
  });
  const devices = await readPowerSupplies(root);
  const byName = Object.fromEntries(devices.map((d) => [d.name, d]));
  assert.equal(devices.length, 3);
  assert.deepEqual(byName['PRO X 2'], { name: 'PRO X 2', percent: 99, charging: false, source: 'logitech' });
  assert.deepEqual(byName['Aerox 3'], { name: 'Aerox 3', percent: 41, charging: true, source: 'usb' });
  assert.deepEqual(byName.Keyboard, { name: 'Keyboard', percent: 70, charging: true, source: 'usb' });
});

test('linux: the entry name tells the transport', () => {
  assert.equal(sourceOf('hidpp_battery_0'), 'logitech');
  assert.equal(sourceOf('hid-aa:bb:cc:dd:ee:ff-battery'), 'bluetooth');
  assert.equal(sourceOf('hid-0003:1038:1234.0001-battery'), 'usb');
});

test('linux: a device that only reports a level still gets a number', async () => {
  const root = powerSupplies({
    hidpp_battery_1: { scope: 'Device', model_name: 'M325', capacity_level: 'Low', status: 'Discharging' },
    hidpp_battery_2: { scope: 'Device', model_name: 'Mystery', capacity_level: 'Unknown', status: 'Unknown' },
  });
  assert.deepEqual((await readPowerSupplies(root)).map((d) => [d.name, d.percent]), [['M325', 20]]);
});

test('linux: no power_supply folder is an empty list', async () => {
  assert.deepEqual(await readPowerSupplies(path.join(os.tmpdir(), 'xenon-no-such-dir')), []);
});

test('macos: ioreg blocks with a product and a level, nothing else', () => {
  const text = [
    '+-o AppleDeviceManagementHIDEventService  <class AppleDeviceManagementHIDEventService>',
    '    {',
    '      "Product" = "Magic Mouse"',
    '      "BatteryPercent" = 86',
    '    }',
    '+-o IOHIDInterface  <class IOHIDInterface>',
    '    {',
    '      "BatteryPercent" = 12',
    '    }',
  ].join('\n');
  assert.deepEqual(parseIoreg(text), [{ name: 'Magic Mouse', percent: 86, charging: null, source: 'bluetooth' }]);
  assert.deepEqual(parseIoreg(''), []);
});

test('windows: the collections of one interface group together, two dongles stay apart', () => {
  const tail = '#{4d1e55b2-f16f-11cf-88cb-001111000030}';
  const a1 = { path: '\\\\?\\hid#vid_046d&pid_c54d&mi_02&col01#a&33979e14&0&0000' + tail };
  const a2 = { path: '\\\\?\\hid#vid_046d&pid_c54d&mi_02&col02#a&33979e14&0&0001' + tail };
  const b1 = { path: '\\\\?\\hid#vid_046d&pid_c54d&mi_02&col01#a&99999999&0&0000' + tail };
  assert.equal(interfaceKey(a1.path), interfaceKey(a2.path));
  assert.notEqual(interfaceKey(a1.path), interfaceKey(b1.path));
  assert.deepEqual(groupByInterface([a1, a2, b1]).map((g) => g.length), [2, 1]);
});

test('razer: one USB device with several interfaces is listed once, a broken one is skipped', async () => {
  const closed = [];
  const hid = {
    async open(info) {
      if (info.path === 'broken') throw new Error('in use');
      return {
        async setFeature(bytes) { this.last = Buffer.from(bytes); },
        async getFeature() { const r = Buffer.from(this.last); r[1] = 2; r[10] = 255; return r; },
        async close() { closed.push(info.path); },
      };
    },
  };
  const devices = await readRazerDevices(hid, [
    { path: 'broken', productId: 1, product: 'Razer Viper' },
    { path: 'a', productId: 1, product: 'Razer Viper' },
    { path: 'b', productId: 1, product: 'Razer Viper' },
  ]);
  assert.deepEqual(devices.map((d) => [d.name, d.source]), [['Razer Viper', 'razer']]);
  assert.deepEqual(closed, ['a'], 'every opened device is closed, and no extra one is opened');
});

test('merge: a dongle reading beats Bluetooth, Corsair beats both, charging survives', () => {
  const map = mergeSources(
    [{ name: 'Both', percent: 30 }],
    [{ name: 'Mouse', percent: 10 }, { name: 'Both', percent: 10 }],
    new Map(), 1000,
    [{ name: 'Mouse', percent: 90, charging: true, source: 'logitech' }, { name: 'Both', percent: 20, source: 'razer' }],
  );
  assert.deepEqual([map.get('mouse').percent, map.get('mouse').charging, map.get('mouse').source], [90, true, 'logitech']);
  assert.deepEqual([map.get('both').percent, map.get('both').source], [30, 'corsair']);
});

test('merge: a mouse asleep on its dongle keeps its last charge, then goes', () => {
  const seen = mergeSources([], [{ name: 'Phone', percent: 40 }], new Map(), 1000, [{ name: 'PRO X 2', percent: 99, source: 'logitech' }]);
  const later = mergeSources([], [], seen, 1000 + STALE_MS + 1);
  assert.deepEqual([...later.keys()], ['pro x 2'], 'a Bluetooth device fades at the usual time');
  assert.equal(mergeSources([], [], later, 1000 + ASLEEP_MS + 1).size, 0);
});

test('merge: an unknown source falls back, a bad reading is dropped', () => {
  const map = mergeSources([], [], new Map(), 1000, [{ name: 'X', percent: 50, source: '<b>' }, { name: 'Y', percent: 500, source: 'razer' }]);
  assert.equal(map.get('x').source, 'usb');
  assert.equal(map.has('y'), false);
});

function monitorWith(peripherals) {
  return createBatteryMonitor({
    runScript: async () => ({ devices: [] }),
    lighting: { getBatteryLevels: async () => ({ ok: false }) },
    peripherals,
  });
}

test('monitor: dongles are asked once per long interval, and stay listed between', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  let reads = 0;
  const monitor = monitorWith(async () => { reads += 1; return { available: true, devices: [{ name: 'PRO X 2', percent: 99, charging: false, source: 'logitech' }] }; });
  const first = await monitor.getDevices({ force: true });
  t.mock.timers.tick(PERIPHERAL_TTL_MS - 1000);
  const second = await monitor.getDevices({ force: true });
  assert.equal(reads, 1);
  assert.equal(first.sources.peripherals, true);
  assert.deepEqual(second.devices.map((d) => d.name), ['PRO X 2']);
  t.mock.timers.tick(2000);
  await monitor.getDevices({ force: true });
  assert.equal(reads, 2);
});

test('monitor: a read that finds nothing is tried again on the next cycle', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const replies = [[], [{ name: 'PRO X 2', percent: 99, charging: false, source: 'logitech' }]];
  let reads = 0;
  const monitor = monitorWith(async () => ({ available: true, devices: replies[Math.min(reads++, 1)] }));
  assert.deepEqual((await monitor.getDevices({ force: true })).devices, []);
  t.mock.timers.tick(TTL_MS);
  const next = await monitor.getDevices({ force: true });
  assert.deepEqual(next.devices.map((d) => d.name), ['PRO X 2']);
  t.mock.timers.tick(TTL_MS);
  await monitor.getDevices({ force: true });
  assert.equal(reads, 2);
});

test('monitor: a failing source reports false and breaks nothing', async () => {
  const payload = await monitorWith(async () => { throw new Error('boom'); }).getDevices({ force: true });
  assert.deepEqual([payload.devices, payload.sources.peripherals], [[], false]);
});

test('monitor: without the source the payload keeps its shape', async () => {
  assert.equal((await monitorWith(null).getDevices({ force: true })).sources.peripherals, false);
});
