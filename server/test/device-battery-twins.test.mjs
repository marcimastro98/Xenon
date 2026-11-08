// Two devices of one model, and a device that stopped answering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { createTwins } = require('../device-battery/twins.js');
const { createBatteryMonitor, FRESH_MS } = require('../battery.js');
const { readLink } = require('../device-battery/hidpp.js');

const mouse = (unit, percent = 50, source = 'logitech') => ({ name: 'PRO X 2', percent, charging: null, source, ...(unit ? { unit } : {}) });
const names = (devices) => devices.map((device) => device.name);

test('twins found together get a number each, the same in any order', () => {
  assert.deepEqual(names(createTwins().label([mouse('b'), mouse('a')])), ['PRO X 2 (2)', 'PRO X 2']);
  assert.deepEqual(names(createTwins().label([mouse('a'), mouse('b')])), ['PRO X 2', 'PRO X 2 (2)']);
});

test('a twin keeps its number while the other one sleeps', () => {
  const twins = createTwins();
  twins.label([mouse('a'), mouse('b')]);
  assert.deepEqual(names(twins.label([mouse('b')])), ['PRO X 2 (2)']);
  assert.deepEqual(names(twins.label([mouse('a')])), ['PRO X 2']);
});

test('one device seen again and again stays plain', () => {
  const twins = createTwins();
  for (let i = 0; i < 3; i++) assert.deepEqual(names(twins.label([mouse('a')])), ['PRO X 2']);
});

test('a device with no unit is never numbered', () => {
  assert.deepEqual(names(createTwins().label([mouse(''), mouse('')])), ['PRO X 2', 'PRO X 2']);
});

test('one mouse on Bluetooth and on its dongle is not two mice', () => {
  const twins = createTwins();
  assert.deepEqual(names(twins.label([mouse('AABBCCDDEEFF', 50, 'bluetooth')])), ['PRO X 2']);
  assert.deepEqual(names(twins.label([mouse('1a2b3c4d', 50, 'logitech')])), ['PRO X 2']);
});

test('label takes what a failed source hands it', () => {
  assert.deepEqual(createTwins().label(undefined), []);
  assert.deepEqual(createTwins().label([null]), [null]);
});

function monitorOver(reads) {
  return createBatteryMonitor({
    runScript: async () => ({ devices: [] }),
    lighting: { getBatteryLevels: async () => ({ ok: false }) },
    peripherals: async () => ({ available: true, devices: reads() }),
  });
}

// Peripheral reads are spaced out, so each step moves the clock past them.
async function at(time, fn) {
  const real = Date.now;
  Date.now = () => time;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

test('the stream lists twins apart, and no unit ever reaches it', async () => {
  const monitor = monitorOver(() => [mouse('a', 80), mouse('b', 20)]);
  const { devices } = await monitor.getDevices({ force: true });
  assert.deepEqual(devices.map((d) => [d.name, d.percent]), [['PRO X 2', 80], ['PRO X 2 (2)', 20]]);
  assert.ok(!JSON.stringify(devices).includes('unit'));
});

test('a device that stopped answering says since when, and nothing about charging', async () => {
  let mice = [{ ...mouse('a', 80), charging: true }];
  const monitor = monitorOver(() => mice);
  const start = Date.now();
  const fresh = await at(start, () => monitor.getDevices({ force: true }));
  assert.equal(fresh.devices[0].lastSeen, undefined);
  assert.equal(fresh.devices[0].charging, true);

  mice = [];
  const later = start + 6 * 60 * 1000;
  const first = await at(later, () => monitor.getDevices({ force: true }));
  assert.equal(first.devices[0].percent, 80);
  assert.equal(first.devices[0].lastSeen, start);
  assert.equal(first.devices[0].charging, null);

  // Nothing changes while it sleeps, so the broadcast's dedup stays quiet.
  const second = await at(later + 60 * 1000, () => monitor.getDevices({ force: true }));
  assert.deepEqual(second.devices, first.devices);
});

test('one missed read does not call a device silent', async () => {
  const monitor = createBatteryMonitor({
    runScript: (() => {
      let reads = 0;
      return async () => ({ devices: reads++ ? [] : [{ name: 'Headset', percent: 60 }] });
    })(),
    lighting: { getBatteryLevels: async () => ({ ok: false }) },
  });
  const start = Date.now();
  await at(start, () => monitor.getDevices({ force: true }));
  const { devices } = await at(start + FRESH_MS, () => monitor.getDevices({ force: true }));
  assert.equal(devices[0].lastSeen, undefined);
});

// A device on the cable behind a stand-in link: features by id, in the order it knows them.
function hidppLink(features) {
  const queue = [];
  const indexes = Object.keys(features);
  return {
    async write(bytes) {
      const [, index, feature, fnAndId] = bytes;
      const reply = Buffer.alloc(20);
      reply[0] = 0x11; reply[1] = index; reply[2] = feature; reply[3] = fnAndId;
      if (feature === 0 && (fnAndId >> 4) === 1) { reply[4] = 4; reply[6] = bytes[6]; }
      if (feature === 0 && (fnAndId >> 4) === 0) reply[4] = indexes.indexOf(((bytes[4] << 8) | bytes[5]).toString()) + 1;
      if (feature > 0) Buffer.from(features[indexes[feature - 1]](fnAndId >> 4)).copy(reply, 4);
      queue.push(reply);
    },
    async read() { return queue.shift() || null; },
  };
}

const battery = { [0x1004]: () => [80, 0, 0, 0] };
const named = { [0x0005]: (fn) => (fn === 0 ? [3] : [...Buffer.from('Pro')]) };

test('a Logitech device gives its own serial as its unit', async () => {
  const link = hidppLink({ ...battery, ...named, [0x0003]: () => [1, 0x1A, 0x2B, 0x3C, 0x4D, 0, 0] });
  const [device] = await readLink(link);
  assert.equal(device.name, 'Pro');
  assert.equal(device.unit, '1a2b3c4d');
});

test('a Logitech device with no serial, or an empty one, has no unit', async () => {
  const [none] = await readLink(hidppLink({ ...battery, ...named }));
  assert.equal(none.unit, undefined);
  const [zero] = await readLink(hidppLink({ ...battery, ...named, [0x0003]: () => [1, 0, 0, 0, 0] }));
  assert.equal(zero.unit, undefined);
});

test('battery.ps1 finds the address in the ids Windows gives Bluetooth nodes, and only there', () => {
  const script = readFileSync(new URL('../battery.ps1', import.meta.url), 'utf8');
  const address = new RegExp(/-match '([^']+)'\) \{ \$unit/.exec(script)[1]);
  const found = (id) => (address.exec(id) || [])[1];
  assert.equal(found('BTHENUM\\DEV_A1B2C3D4E5F6\\7&1A2B3C4D&0&BLUETOOTHDEVICE_A1B2C3D4E5F6'), 'A1B2C3D4E5F6');
  assert.equal(found('BTHENUM\\{0000111E-0000-1000-8000-00805F9B34FB}_VID&0001004C_PID&200E\\7&1A2B3C4D&0&A1B2C3D4E5F6_C00000000'), 'A1B2C3D4E5F6');
  assert.equal(found('BTHLEDEVICE\\{0000180F-0000-1000-8000-00805F9B34FB}_DEV_VID&02046D_PID&B023_REV&0011_A1B2C3D4E5F6\\8&2B&0&000E'), 'A1B2C3D4E5F6');
  assert.equal(found('HID\\{00001124-0000-1000-8000-00805F9B34FB}_VID&0002046D_PID&B023&COL01\\8&2BBF1234&0&0000'), undefined);
});
