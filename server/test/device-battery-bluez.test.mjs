// BlueZ on Linux. `start.mjs airpods` in tools/linux-rgb-vm runs the same reader against a real
// bluetoothd; these pin the decisions around it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readBluez, parseObjects } = require('../device-battery/bluez.js');
const { createGuard } = require('../device-battery/guard.js');

const DEVICE = 'org.bluez.Device1';
const IN_CASE = [0x07, 0x19, 0x01, 0x24, 0x20, 0x73, 0xaa, 0x97, 0x31, 0x00];
const LEVEL = { 'org.bluez.Battery1': { Percentage: 64 } };
const ADAPTER = '/org/bluez/hci0';

const device = (props) => ({ [DEVICE]: { Adapter: ADAPTER, ...props } });
const objects = (...list) => Object.fromEntries(list.map((object, i) => [`${ADAPTER}/dev_${i}`, object]));
const pair = device({ Alias: 'AirPods Pro', Connected: true });
const advert = (rssi) => device({ Connected: false, RSSI: rssi, ManufacturerData: { 76: IN_CASE } });

// Each GetManagedObjects answers with the next view; the last one repeats.
function fakeBus(views, { failOn = null } = {}) {
  const calls = [];
  let closed = false;
  let look = 0;
  const bus = {
    calls,
    get closed() { return closed; },
    close() { closed = true; },
    async call({ member }) {
      calls.push(member);
      if (member === failOn) throw new Error('org.bluez.Error.Failed');
      if (member !== 'GetManagedObjects') return undefined;
      look += 1;
      return views[Math.min(look - 1, views.length - 1)];
    },
  };
  return bus;
}

const read = (bus, ask = true, guard = createGuard()) => readBluez({ ask, guard, connect: async () => bus });

test('a pair is known by name, or renamed by maker and audio icon, and an iPhone is not one', () => {
  const seen = parseObjects(objects(
    pair,
    device({ Alias: 'My buds', Connected: true, Modalias: 'bluetooth:v004Cp2024d0B80', Icon: 'audio-headset' }),
    device({ Alias: 'iPhone', Connected: true, Modalias: 'bluetooth:v004Cp7205d0B80', Icon: 'phone' }),
    device({ Alias: 'AirPods old', Connected: false }),
  ));
  assert.deepEqual(seen.connected, ['AirPods Pro', 'My buds']);
  assert.equal(seen.adapter, ADAPTER);
});

test('an advert without RSSI is from an earlier scan and does not count', () => {
  const old = device({ Connected: false, ManufacturerData: { 76: IN_CASE } });
  assert.deepEqual(parseObjects(objects(old)).adverts, []);
  assert.deepEqual(parseObjects(objects(advert(-50))).adverts, [{ rssi: -50, hex: '071901242073aa973100' }]);
});

test('Battery1 of a connected device is listed, of a gone one is not', () => {
  const seen = parseObjects(objects(
    { ...device({ Name: 'WH-1000XM5', Connected: true }), ...LEVEL },
    { ...device({ Name: 'Old', Connected: false }), ...LEVEL },
  ));
  assert.deepEqual(seen.batteries, [{ name: 'WH-1000XM5', percent: 64, charging: null, source: 'bluetooth' }]);
});

test('no pair connected: no scan, and the bus is closed', async () => {
  const bus = fakeBus([objects(advert(-40))]);
  assert.deepEqual(await read(bus), []);
  assert.deepEqual(bus.calls, ['GetManagedObjects']);
  assert.equal(bus.closed, true);
});

test('asking off: no scan, and Battery1 still shows', async () => {
  const bus = fakeBus([objects(pair, { ...device({ Name: 'Sony', Connected: true }), ...LEVEL })]);
  assert.deepEqual((await read(bus, false)).map((d) => d.name), ['Sony']);
  assert.equal(bus.calls.includes('StartDiscovery'), false);
});

test('a pair in range: LE filter first, buds and case, scan stopped, no second row from Battery1', async () => {
  const bus = fakeBus([objects({ ...pair, ...LEVEL }, advert(-50))]);
  const found = await read(bus);
  assert.deepEqual(found.map((d) => [d.name, d.percent]), [['AirPods Pro', 100], ['AirPods Pro case', 70]]);
  assert.deepEqual(bus.calls.filter((c) => c !== 'GetManagedObjects'), ['SetDiscoveryFilter', 'StartDiscovery', 'StopDiscovery']);
});

test('an advert seen at only one look of the scan still reads', async () => {
  const bus = fakeBus([objects(pair), objects(pair), objects(pair, advert(-50)), objects(pair)]);
  assert.equal((await read(bus))[0].percent, 100);
});

test('no bus, a refused scan or bad data is no reading, and the guard is left', async () => {
  const guard = createGuard();
  assert.deepEqual(await readBluez({ ask: true, guard, connect: async () => { throw new Error('ENOENT'); } }), []);
  const refused = fakeBus([objects(pair)], { failOn: 'StartDiscovery' });
  assert.deepEqual(await read(refused, true, guard), []);
  assert.equal(refused.closed, true);
  assert.deepEqual(await read(fakeBus([null]), true, guard), []);
});
