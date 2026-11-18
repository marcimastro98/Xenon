// The kind of device each battery belongs to: what every reader takes it from (a HID usage,
// a Bluetooth class, a protocol's device type, a product-id table) and how the merge keeps
// it. All values are invented; none comes from a real device's name.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const kinds = require('../device-battery/kinds.js');
const { MODELS } = require('../device-battery/brands/index.js');
const { kindOf } = require('../device-battery/linux.js');
const { parseObjects } = require('../device-battery/bluez.js');
const { kindOfProduct } = require('../device-battery/standard-windows.js');
const { createTwins } = require('../device-battery/twins.js');
const { createBatteryMonitor, mergeSources, STALE_MS } = require('../battery.js');

const hex = (text) => Buffer.from(text.replace(/\s+/g, ''), 'hex');
// Generic Desktop mouse, keyboard and game pad descriptors, trimmed to their collections.
const MOUSE = hex('05 01 09 02 a1 01 09 01 a1 00 05 09 19 01 29 03 15 00 25 01 95 03 75 01 81 02 c0 c0');
const KEYBOARD = hex('05 01 09 06 a1 01 05 07 19 e0 29 e7 15 00 25 01 75 01 95 08 81 02 c0');
const GAMEPAD = hex('05 01 09 05 a1 01 05 09 19 01 29 10 95 10 75 01 81 02 c0');
const CONSUMER = hex('05 0c 09 01 a1 01 0a 23 02 75 10 95 01 81 00 c0');

test('the kind list is the documented one, and anything else is unknown', () => {
  assert.deepEqual(kinds.KINDS, ['mouse', 'keyboard', 'headset', 'controller', 'system', 'ups', 'other', 'unknown']);
  for (const k of kinds.KINDS) assert.equal(kinds.normalizeKind(k), k);
  for (const bad of ['Mouse', 'toaster', '', null, undefined, 3, {}, ['mouse']]) assert.equal(kinds.normalizeKind(bad), 'unknown');
});

test('HID descriptor: the top-level application collections, one kind among them or unknown', () => {
  assert.deepEqual(kinds.applicationUsages(MOUSE), [[1, 2]]);
  assert.equal(kinds.kindOfUsages(kinds.applicationUsages(MOUSE)), 'mouse');
  assert.equal(kinds.kindOfUsages(kinds.applicationUsages(KEYBOARD)), 'keyboard');
  assert.equal(kinds.kindOfUsages(kinds.applicationUsages(GAMEPAD)), 'controller');
  // A consumer collection beside the mouse says nothing either way.
  assert.equal(kinds.kindOfUsages(kinds.applicationUsages(Buffer.concat([MOUSE, CONSUMER]))), 'mouse');
  // A mouse that also declares a keyboard for its macros is not sure of either.
  assert.equal(kinds.kindOfUsages(kinds.applicationUsages(Buffer.concat([MOUSE, KEYBOARD]))), 'unknown');
  assert.equal(kinds.kindOfUsages(kinds.applicationUsages(CONSUMER)), 'unknown');
  // An extended usage carries its own page; Push and Pop restore the page around it.
  assert.deepEqual(kinds.applicationUsages(hex('05 0c a4 05 01 b4 0b 06 00 01 00 a1 01 c0')), [[1, 6]]);
  assert.deepEqual(kinds.applicationUsages(hex('05 01 a4 05 0c b4 09 02 a1 01 c0')), [[1, 2]]);
  assert.deepEqual(kinds.applicationUsages(Buffer.alloc(0)), []);
  assert.deepEqual(kinds.applicationUsages('not bytes'), []);
  assert.deepEqual(kinds.applicationUsages(hex('05 01 09')), []);
});

test('Bluetooth Class of Device, LE Appearance and BlueZ Icon', () => {
  assert.equal(kinds.kindOfClass(0x002540), 'keyboard');
  assert.equal(kinds.kindOfClass(0x002580), 'mouse');
  assert.equal(kinds.kindOfClass(0x0025C0), 'keyboard');   // keyboard and pointer in one
  assert.equal(kinds.kindOfClass(0x002508), 'controller');
  assert.equal(kinds.kindOfClass(0x240404), 'headset');
  assert.equal(kinds.kindOfClass(0x240418), 'headset');
  assert.equal(kinds.kindOfClass(0x240414), 'other');      // loudspeaker
  assert.equal(kinds.kindOfClass(0x5A020C), 'other');      // phone
  assert.equal(kinds.kindOfClass(0), 'unknown');
  assert.equal(kinds.kindOfClass(0x001F00), 'unknown');    // uncategorized
  assert.equal(kinds.kindOfClass('0x2540'), 'unknown');
  assert.equal(kinds.kindOfAppearance(0x03C2), 'mouse');
  assert.equal(kinds.kindOfAppearance(0x03C1), 'keyboard');
  assert.equal(kinds.kindOfAppearance(0x03C4), 'controller');
  assert.equal(kinds.kindOfAppearance(0x0941), 'headset');
  assert.equal(kinds.kindOfAppearance(0x00C0), 'other');   // watch
  assert.equal(kinds.kindOfAppearance(0x03C0), 'unknown'); // generic HID
  assert.equal(kinds.kindOfIcon('input-gaming'), 'controller');
  assert.equal(kinds.kindOfIcon('audio-headphones'), 'headset');
  assert.equal(kinds.kindOfIcon('something-new'), 'unknown');
  assert.equal(kinds.kindOfBluetooth({ appearance: 0x03C2, icon: 'input-keyboard' }), 'mouse');
  assert.equal(kinds.kindOfBluetooth({ icon: 'input-keyboard' }), 'keyboard');
  assert.equal(kinds.kindOfBluetooth(), 'unknown');
});

test('protocol device types: HID++ getDeviceType and the iCUE device type', () => {
  assert.deepEqual([0, 2, 3, 4, 5, 8, 11, 12].map(kinds.kindOfHidppType), ['keyboard', 'keyboard', 'mouse', 'mouse', 'mouse', 'headset', 'controller', 'controller']);
  assert.equal(kinds.kindOfHidppType(9), 'other');   // webcam
  assert.equal(kinds.kindOfHidppType(-1), 'unknown');
  assert.equal(kinds.kindOfHidppType(20), 'unknown');
  assert.equal(kinds.kindOfCorsairType(0x0002), 'mouse');
  assert.equal(kinds.kindOfCorsairType(0x0001), 'keyboard');
  assert.equal(kinds.kindOfCorsairType(0x0008), 'headset');
  assert.equal(kinds.kindOfCorsairType(0x1000), 'controller');
  assert.equal(kinds.kindOfCorsairType(0x0010), 'other');   // headset stand
  assert.equal(kinds.kindOfCorsairType(0), 'unknown');
  assert.equal(kinds.kindOfCorsairType(0x0003), 'unknown'); // two bits is no real device
});

test('Windows: battery.ps1 class, input nodes and battery bus', () => {
  assert.equal(kinds.kindOfWindowsEntry({ name: 'x', cod: 0x240404 }), 'headset');
  assert.equal(kinds.kindOfWindowsEntry({ name: 'x', inputs: ['Mouse'] }), 'mouse');
  assert.equal(kinds.kindOfWindowsEntry({ name: 'x', inputs: 'Keyboard' }), 'keyboard');
  assert.equal(kinds.kindOfWindowsEntry({ name: 'x', inputs: ['Mouse', 'Keyboard'] }), 'unknown');
  assert.equal(kinds.kindOfWindowsEntry({ name: 'Keyboard mouse' }), 'unknown');
  assert.equal(kinds.kindOfWindowsEntry({ name: 'x', type: 'system', bus: 'ACPI' }), 'system');
  assert.equal(kinds.kindOfWindowsEntry({ name: 'x', type: 'system', bus: 'HID' }), 'ups');
  assert.equal(kinds.kindOfWindowsEntry({ name: 'x', type: 'system' }), 'unknown');
  assert.equal(kinds.kindOfWindowsEntry(null), 'unknown');
});

test('Windows standard route: the collections of the same product, nothing else', () => {
  const info = { vendorId: 0x1234, productId: 0x0001, usagePage: 0x0C, usage: 1 };
  const infos = [info, { ...info, usagePage: 1, usage: 2 }, { vendorId: 0x1234, productId: 0x0002, usagePage: 1, usage: 6 }];
  assert.equal(kindOfProduct(info, infos), 'mouse');
  assert.equal(kindOfProduct(info, [...infos, { ...info, usagePage: 1, usage: 6 }]), 'unknown');
});

test('Linux: a UPS by its type, a HID device by its report descriptor, else unknown', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-kind-'));
  const entry = (name, files) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'device'), { recursive: true });
    for (const [file, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), value);
    return dir;
  };
  assert.equal(await kindOf(entry('ups', { type: 'UPS\n' })), 'ups');
  assert.equal(await kindOf(entry('mouse', { type: 'Battery\n', 'device/report_descriptor': MOUSE })), 'mouse');
  assert.equal(await kindOf(entry('pad', { type: 'Battery\n', 'device/report_descriptor': GAMEPAD })), 'controller');
  assert.equal(await kindOf(entry('bare', { type: 'Battery\n' })), 'unknown');
});

test('BlueZ: the kind from the Device1 class, appearance or icon', () => {
  const level = { 'org.bluez.Battery1': { Percentage: 50 } };
  const device = (props) => ({ 'org.bluez.Device1': { Connected: true, Name: 'Device', ...props }, ...level });
  const seen = parseObjects({
    a: device({ Class: 0x240404 }),
    b: device({ Appearance: 0x03C2 }),
    c: device({ Icon: 'input-gaming' }),
    d: device({}),
  });
  assert.deepEqual(seen.batteries.map((d) => d.kind), ['headset', 'mouse', 'controller', 'unknown']);
});

test('brand tables: a kind is one a product id can be sure of, or left out', () => {
  const allowed = new Set(['mouse', 'keyboard', 'headset', 'controller']);
  for (const model of MODELS) {
    if (model.kind !== undefined) assert.ok(allowed.has(model.kind), `${model.label}: ${model.kind}`);
  }
  // Tables that are all one kind of device.
  const byFile = (file) => require(`../device-battery/brands/${file}.js`);
  for (const file of ['logitech-headsets', 'logitech-centurion', 'razer-headsets', 'sony-headsets']) {
    for (const model of byFile(file)) assert.equal(model.kind, 'headset', model.label);
  }
  for (const file of ['gamepads', 'playstation']) for (const model of byFile(file)) assert.equal(model.kind, 'controller', model.label);
  // A receiver that serves a keyboard or a mouse depends on the slot, and says so per reading.
  for (const model of byFile('rongyuan')) assert.equal(model.kind, undefined);
});

test('merge: a value outside the list is unknown, a missing one too', () => {
  const map = mergeSources([], [{ name: 'A', percent: 50, kind: 'toaster' }, { name: 'B', percent: 50 }, { name: 'C', percent: 50, kind: 'mouse' }], new Map(), 1000);
  assert.deepEqual([...map.values()].map((d) => [d.name, d.kind]), [['A', 'unknown'], ['B', 'unknown'], ['C', 'mouse']]);
});

test('merge: a read that cannot tell keeps the kind an earlier one knew, and a later one can change it', () => {
  let map = mergeSources([], [{ name: 'Pad', percent: 50, kind: 'controller' }], new Map(), 1000);
  map = mergeSources([], [{ name: 'Pad', percent: 49, kind: 'unknown' }], map, 2000);
  assert.equal(map.get('pad').kind, 'controller');
  // Same name, a route that knows better (iCUE after Bluetooth) wins.
  map = mergeSources([{ name: 'Pad', percent: 48, kind: 'mouse' }], [{ name: 'Pad', percent: 48 }], map, 3000);
  assert.equal(map.get('pad').kind, 'mouse');
  // Gone quiet but not yet dropped: the entry, kind included, stays as it was.
  map = mergeSources([], [], map, 3000 + STALE_MS - 1);
  assert.equal(map.get('pad').kind, 'mouse');
});

test('twins keep their kind when they get a number', () => {
  const twins = createTwins();
  const labelled = twins.label([{ name: 'Same', percent: 40, kind: 'mouse', unit: 'u1' }, { name: 'Same', percent: 60, kind: 'keyboard', unit: 'u2' }]);
  assert.deepEqual(labelled.map((d) => d.kind), ['mouse', 'keyboard']);
});

test('monitor: Corsair and Windows routes give a kind, the raw fields never reach the wire', async () => {
  const lighting = { getBatteryLevels: async () => ({ ok: true, devices: [{ name: 'Wireless one', percent: 70, unit: 'c1', corsairType: 0x0008 }] }) };
  const runScript = async () => ({ devices: [
    { name: 'Classic', percent: 50, unit: 'b1', cod: 0x002580 },
    { name: 'Low energy', percent: 60, unit: 'b2', inputs: ['Keyboard'] },
    { name: 'Internal battery', percent: 80, charging: true, type: 'system', bus: 'ACPI' },
  ] });
  const monitor = createBatteryMonitor({ runScript, lighting });
  const { devices } = await monitor.getDevices();
  assert.deepEqual(devices.map((d) => [d.name, d.kind]), [['Classic', 'mouse'], ['Internal battery', 'system'], ['Low energy', 'keyboard'], ['Wireless one', 'headset']]);
  for (const d of devices) {
    assert.deepEqual(Object.keys(d).sort(), ['charging', 'id', 'kind', 'name', 'percent', 'source']);
  }
});

test('the SDK docs list the kind and every value it can take', () => {
  const doc = fs.readFileSync(new URL('../../docs/WIDGET_SDK.md', import.meta.url), 'utf8');
  const start = doc.indexOf('The `battery` stream is separate');
  assert.ok(start > 0);
  const section = doc.slice(start, doc.indexOf('\n### ', start));
  assert.match(section, /kind: 'keyboard'/);
  for (const k of kinds.KINDS) assert.ok(section.includes(`'${k}'`), k);
  assert.match(doc, /`\.asleep` and `\.kind`/);
});
