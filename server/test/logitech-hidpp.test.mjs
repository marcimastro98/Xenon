// HID++ reads against a simulated device: what goes out, what is decoded, and
// that a silent, refusing or noisy device can never hang or fake a reading.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const hidpp = require('../device-battery/hidpp.js');

const SW = 0x0A;
const ROOT_PING = (1 << 4) | SW;
const ROOT_FEATURE = SW;
const NAME_FEATURE = 0x0005;

function report(index, featureIndex, tag, data) {
  const bytes = Buffer.alloc(20);
  bytes[0] = 0x11;
  bytes[1] = index;
  bytes[2] = featureIndex;
  bytes[3] = tag;
  Buffer.from(data).copy(bytes, 4);
  return bytes;
}

// A device as HID++ sees it: features by id, in the order of their index.
function simDevice({ name = 'PRO X 2', features = {}, protocol = 4 }) {
  const ids = [NAME_FEATURE, ...Object.keys(features).map(Number)];
  return { name, features, protocol, indexOf: (id) => ids.indexOf(id) + 1, idAt: (at) => ids[at - 1] };
}

// devices: { [index]: simDevice }. Anything else answers "unknown device".
function simLink(devices, { noise = [], silent = false } = {}) {
  const queue = [...noise];
  const sent = [];
  return {
    sent,
    async write(bytes) {
      sent.push(Buffer.from(bytes));
      if (silent) return;
      const [, index, at, tag] = bytes;
      const fn = tag >> 4;
      const device = devices[index];
      if (!device) { queue.push(Buffer.from([0x10, index, 0x8F, at, tag, 8, 0])); return; }
      if (at === 0 && tag === ROOT_PING) { queue.push(report(index, 0, tag, [device.protocol, 2, bytes[6]])); return; }
      if (at === 0 && tag === ROOT_FEATURE) {
        const found = device.indexOf((bytes[4] << 8) | bytes[5]);
        queue.push(report(index, 0, tag, [Math.max(found, 0)]));
        return;
      }
      const id = device.idAt(at);
      if (id === NAME_FEATURE) {
        const data = fn === 0 ? [device.name.length] : [...Buffer.from(device.name.slice(bytes[4], bytes[4] + 16))];
        queue.push(report(index, at, tag, data));
        return;
      }
      queue.push(report(index, at, tag, device.features[id]));
    },
    async read(timeoutMs) {
      if (queue.length) return queue.shift();
      await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 5)));
      return null;
    },
  };
}

test('every request is a long report that carries our software id', () => {
  const bytes = hidpp.request(1, 3, 2, [7, 8]);
  assert.equal(bytes.length, hidpp.LONG_REPORT_BYTES);
  assert.deepEqual([...bytes.subarray(0, 6)], [0x11, 1, 3, (2 << 4) | SW, 7, 8]);
});

test('matchReply takes only our answer', () => {
  assert.deepEqual([...hidpp.matchReply(report(1, 3, SW, [99]), 1, 3, 0).data.subarray(0, 1)], [99]);
  assert.equal(hidpp.matchReply(report(2, 3, SW, [99]), 1, 3, 0), null, 'another slot');
  assert.equal(hidpp.matchReply(report(1, 3, 0x01, [99]), 1, 3, 0), null, 'another program');
  assert.equal(hidpp.matchReply(report(1, 4, SW, [99]), 1, 3, 0), null, 'another feature');
  assert.equal(hidpp.matchReply(null, 1, 3, 0), null);
  assert.equal(hidpp.matchReply(Buffer.from([0x11, 1]), 1, 3, 0), null, 'a torn report');
});

test('matchReply reads both refusals', () => {
  assert.deepEqual(hidpp.matchReply(Buffer.from([0x11, 1, 0xFF, 3, SW, 5, 0]), 1, 3, 0), { error: 5 });
  assert.deepEqual(hidpp.matchReply(Buffer.from([0x10, 1, 0x8F, 3, SW, 8, 0]), 1, 3, 0), { error: 8 });
});

test('unified battery: real readings from a PRO X 2', () => {
  assert.deepEqual(hidpp.decodeUnifiedBattery(Buffer.from([100, 8, 3, 1])), { percent: 100, charging: true });
  assert.deepEqual(hidpp.decodeUnifiedBattery(Buffer.from([99, 8, 0, 0])), { percent: 99, charging: false });
});

test('unified battery: a band stands in for a missing fuel gauge', () => {
  assert.equal(hidpp.decodeUnifiedBattery(Buffer.from([0, 4, 0, 0])).percent, 50);
  assert.equal(hidpp.decodeUnifiedBattery(Buffer.from([0, 1, 0, 0])).percent, 5);
  assert.equal(hidpp.decodeUnifiedBattery(Buffer.from([0, 0, 0, 0])), null);
  assert.equal(hidpp.decodeUnifiedBattery(Buffer.from([101, 8, 0, 0])), null);
});

test('unified battery: a charging fault is not charging', () => {
  assert.equal(hidpp.decodeUnifiedBattery(Buffer.from([40, 4, 4, 1])).charging, false);
});

test('battery status: percent and charger states', () => {
  assert.deepEqual(hidpp.decodeBatteryStatus(Buffer.from([70, 50, 0])), { percent: 70, charging: false });
  for (const state of [1, 2, 3, 4]) assert.equal(hidpp.decodeBatteryStatus(Buffer.from([70, 50, state])).charging, true);
  assert.equal(hidpp.decodeBatteryStatus(Buffer.from([70, 50, 5])).charging, false);
  assert.equal(hidpp.decodeBatteryStatus(Buffer.from([0, 0, 0])), null);
});

test('voltage: the curve holds at its ends and between its points', () => {
  assert.equal(hidpp.percentFromVoltage(4300), 100);
  assert.equal(hidpp.percentFromVoltage(4186), 100);
  assert.equal(hidpp.percentFromVoltage(3811), 50);
  assert.equal(hidpp.percentFromVoltage(3794), 45);
  assert.equal(hidpp.percentFromVoltage(3500), 0);
  assert.equal(hidpp.percentFromVoltage(3000), 0);
  let last = 101;
  for (let mv = 3400; mv <= 4300; mv += 1) {
    const percent = hidpp.percentFromVoltage(mv);
    assert.ok(percent >= 0 && percent <= 100);
    if (last <= 100) assert.ok(percent >= last, `${mv} mV goes down`);
    last = percent;
  }
});

test('voltage: the charging flag, and no voltage means no reading', () => {
  assert.deepEqual(hidpp.decodeBatteryVoltage(Buffer.from([0x0E, 0xE3, 0x80])), { percent: 50, charging: true });
  assert.equal(hidpp.decodeBatteryVoltage(Buffer.from([0x0E, 0xE3, 0x00])).charging, false);
  assert.equal(hidpp.decodeBatteryVoltage(Buffer.from([0, 0, 0])), null);
});

test('readLink: a mouse on its cable answers on the direct index', async () => {
  const link = simLink({ 0xFF: simDevice({ features: { 0x1004: [100, 8, 3, 1] } }) });
  assert.deepEqual(await hidpp.readLink(link), [{ name: 'PRO X 2', percent: 100, charging: true }]);
});

test('readLink: a receiver lists what is on its slots, and skips the empty ones', async () => {
  const link = simLink({
    1: simDevice({ features: { 0x1004: [99, 8, 0, 0] } }),
    3: simDevice({ name: 'MX Keys Mini', features: { 0x1000: [60, 50, 0] } }),
  });
  assert.deepEqual(await hidpp.readLink(link), [
    { name: 'PRO X 2', percent: 99, charging: false },
    { name: 'MX Keys Mini', percent: 60, charging: false },
  ]);
});

test('readLink: the richest feature wins, and a useless one falls through', async () => {
  const both = simDevice({ features: { 0x1000: [10, 0, 0], 0x1004: [80, 8, 0, 0] } });
  assert.equal((await hidpp.readLink(simLink({ 1: both })))[0].percent, 80);
  const broken = simDevice({ features: { 0x1004: [0, 0, 0, 0], 0x1001: [0x0E, 0xE3, 0] } });
  assert.equal((await hidpp.readLink(simLink({ 1: broken })))[0].percent, 50);
});

test('readLink: wired gear with no battery lists nothing', async () => {
  assert.deepEqual(await hidpp.readLink(simLink({ 0xFF: simDevice({ name: 'PRO X' }) })), []);
});

test('readLink: a name longer than one report arrives whole', async () => {
  const name = 'A very long wireless mouse name';
  const link = simLink({ 1: simDevice({ name, features: { 0x1000: [60, 50, 0] } }) });
  assert.equal((await hidpp.readLink(link))[0].name, name);
});

test('readLink: no name feature still gives a reading', async () => {
  const device = simDevice({ features: { 0x1000: [60, 50, 0] } });
  const plain = { ...device, indexOf: (id) => (id === 0x1000 ? 1 : 0), idAt: () => 0x1000 };
  assert.equal((await hidpp.readLink(simLink({ 1: plain })))[0].name, 'Logitech device');
});

test('readLink: HID++ 1.0 devices are left out, not misread', async () => {
  const old = simDevice({ protocol: 1, features: { 0x1000: [60, 50, 0] } });
  assert.deepEqual(await hidpp.readLink(simLink({ 1: old })), []);
});

test('readLink: traffic from other programs is ignored', async () => {
  const noise = [report(1, 0, 0x01, [9, 9, 9]), report(1, 2, 0x00, [1]), Buffer.from([0x11])];
  const link = simLink({ 1: simDevice({ features: { 0x1004: [55, 4, 0, 0] } }) }, { noise });
  assert.equal((await hidpp.readLink(link))[0].percent, 55);
});

test('createAsk: a silent device times out instead of hanging', async () => {
  const ask = hidpp.createAsk(simLink({}, { silent: true }), 30);
  assert.deepEqual(await ask(1, 0, 1, []), { error: 'timeout' });
});

test('nothing sent ever leaves the read-only functions', async () => {
  const link = simLink({
    0xFF: simDevice({ features: { 0x1004: [99, 8, 0, 0], 0x1000: [60, 50, 0], 0x1001: [0x0E, 0xE3, 0] } }),
  });
  await hidpp.readLink(link);
  const device = simDevice({ features: { 0x1004: [], 0x1000: [], 0x1001: [] } });
  const allowed = new Map([
    [0, [0, 1]],                         // root: getFeature, ping
    [device.indexOf(0x0005), [0, 1]],    // name: length, characters
    [device.indexOf(0x1004), [1]],       // unified battery: status
  ]);
  for (const bytes of link.sent) {
    assert.ok(allowed.get(bytes[2])?.includes(bytes[3] >> 4), `feature ${bytes[2]} function ${bytes[3] >> 4}`);
  }
});
