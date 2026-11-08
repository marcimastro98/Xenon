// Native lighting on Linux: /dev/hidraw found through sysfs and driven by ioctl.
// These tests pin what can be pinned off Linux (the parsers, the ioctl numbers, the
// listing over a fake sysfs, the calls made through a fake ioctl);
// tools/linux-rgb-vm runs the same code on a real kernel against a simulated chip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseHidId, parseHidName, topCollections, setFeatureRequest, getFeatureRequest } = require('../hid/hidraw-format.js');
const { createHidLinux } = require('../hid/hid-linux.js');
const { boundedCall } = require('../hid/bounded-call.js');
const P = require('../lighting-native/fusion2-protocol.js');

const FEATURE_ITEMS = [0x85, 0xCC, 0x09, 0x01, 0x15, 0x00, 0x26, 0xFF, 0x00, 0x75, 0x08, 0x95, 0x3F, 0xB1, 0x02];
const FUSION_DESCRIPTOR = Buffer.from([0x06, 0x89, 0xFF, 0x09, 0xCC, 0xA1, 0x01, ...FEATURE_ITEMS, 0xC0]);
const KEYBOARD_DESCRIPTOR = Buffer.from([0x05, 0x01, 0x09, 0x06, 0xA1, 0x01, 0xC0]);
const FILTER = { vendorId: P.VENDOR_ID, productIds: P.PRODUCT_IDS, usagePage: P.USAGE_PAGE };

test('the uevent gives vendor and product', () => {
  const uevent = 'DRIVER=hid-generic\nHID_ID=0003:0000048D:00005711\nHID_NAME=ITE Tech. Inc. GIGABYTE Device\n';
  assert.deepEqual(parseHidId(uevent), { vendorId: 0x048D, productId: 0x5711 });
  assert.deepEqual(parseHidId('HID_ID=0005:0000046D:0000B342\n'), { vendorId: 0x046D, productId: 0xB342 });
});

test('a uevent without a usable HID_ID is no device', () => {
  for (const bad of ['', 'DRIVER=hid-generic\n', 'HID_ID=nonsense\n', 'XHID_ID=0003:0000048D:00005711\n', null, undefined]) {
    assert.equal(parseHidId(bad), null);
  }
});

test('a Fusion descriptor gives its usage page and usage, not the ones nested inside', () => {
  assert.deepEqual(topCollections(FUSION_DESCRIPTOR), [{ usagePage: 0xFF89, usage: 0xCC }]);
});

test('every top-level collection is reported, nested ones are not', () => {
  const bytes = [
    0x05, 0x01, 0x09, 0x02, 0xA1, 0x01,        // mouse
    0x09, 0x01, 0xA1, 0x00, 0xC0,              //   pointer, nested
    0xC0,
    0x06, 0x89, 0xFF, 0x09, 0xCC, 0xA1, 0x01, 0xC0,
  ];
  assert.deepEqual(topCollections(Buffer.from(bytes)), [{ usagePage: 1, usage: 2 }, { usagePage: 0xFF89, usage: 0xCC }]);
});

test('a 4-byte usage names its own page, for that collection only', () => {
  const bytes = [0x05, 0x01, 0x0B, 0xCC, 0x00, 0x89, 0xFF, 0xA1, 0x01, 0xC0, 0x09, 0x06, 0xA1, 0x01, 0xC0];
  assert.deepEqual(topCollections(Buffer.from(bytes)), [{ usagePage: 0xFF89, usage: 0xCC }, { usagePage: 1, usage: 6 }]);
});

test('push and pop bring the usage page back', () => {
  const bytes = [0x05, 0x01, 0xA4, 0x05, 0x0C, 0xB4, 0x09, 0x06, 0xA1, 0x01, 0xC0];
  assert.deepEqual(topCollections(Buffer.from(bytes)), [{ usagePage: 1, usage: 6 }]);
});

test('a usage ended by another main item does not name the next collection', () => {
  const bytes = [0x05, 0x01, 0x09, 0x06, 0x81, 0x02, 0xA1, 0x01, 0xC0];
  assert.deepEqual(topCollections(Buffer.from(bytes)), []);
});

test('long items are stepped over, and a malformed descriptor never throws', () => {
  const long = [0xFE, 0x02, 0x10, 0xAA, 0xBB];
  assert.deepEqual(topCollections(Buffer.from([...long, ...FUSION_DESCRIPTOR])), [{ usagePage: 0xFF89, usage: 0xCC }]);
  assert.deepEqual(topCollections(Buffer.alloc(0)), []);
  assert.deepEqual(topCollections(Buffer.from([0x06, 0x89])), []);
  assert.deepEqual(topCollections(Buffer.from([0xFE])), []);
  assert.deepEqual(topCollections(Buffer.from([0xC0, 0xC0, 0xC0])), []);
});

test('the ioctl numbers are the kernel\'s, top bits included', () => {
  assert.equal(setFeatureRequest(64), 0xC0404806);
  assert.equal(getFeatureRequest(64), 0xC0404807);
  assert.equal(setFeatureRequest(9), 0xC0094806);
});

function fakeSysfs(t, nodes) {
  const dir = mkdtempSync(path.join(tmpdir(), 'xenon-hidraw-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, node] of Object.entries(nodes)) {
    mkdirSync(path.join(dir, name, 'device'), { recursive: true });
    if (node.uevent != null) writeFileSync(path.join(dir, name, 'device', 'uevent'), node.uevent);
    if (node.descriptor) writeFileSync(path.join(dir, name, 'device', 'report_descriptor'), node.descriptor);
  }
  return dir;
}

const uevent = (vid, pid) => `HID_ID=0003:${vid.toString(16).padStart(8, '0').toUpperCase()}:${pid.toString(16).padStart(8, '0').toUpperCase()}\n`;

test('listing finds the chips over sysfs and leaves everything else out', async (t) => {
  const sysDir = fakeSysfs(t, {
    hidraw0: { uevent: uevent(0x046D, 0xC33F), descriptor: KEYBOARD_DESCRIPTOR },
    hidraw3: { uevent: uevent(0x048D, 0x5711), descriptor: FUSION_DESCRIPTOR },
    hidraw4: { uevent: uevent(0x048D, 0x1234), descriptor: FUSION_DESCRIPTOR },     // same maker, other product
    hidraw5: { uevent: uevent(0x048D, 0x8297), descriptor: KEYBOARD_DESCRIPTOR },   // right chip, other interface
    hidraw6: { uevent: 'DRIVER=hid-generic\n', descriptor: FUSION_DESCRIPTOR },
    hidraw7: { uevent: uevent(0x048D, 0x5702) },                                    // unplugged mid-listing
    notanode: { uevent: uevent(0x048D, 0x5711), descriptor: FUSION_DESCRIPTOR },
  });
  const found = await createHidLinux({ sysDir }).list(FILTER);
  assert.deepEqual(found, [{ path: '/dev/hidraw3', vendorId: 0x048D, productId: 0x5711, usagePage: 0xFF89, usage: 0xCC, featureLength: 64, product: '' }]);
});

test('every chip the driver knows is listed, the same way', async (t) => {
  const nodes = Object.fromEntries(P.PRODUCT_IDS.map((pid, i) => ['hidraw' + i, { uevent: uevent(P.VENDOR_ID, pid), descriptor: FUSION_DESCRIPTOR }]));
  const found = await createHidLinux({ sysDir: fakeSysfs(t, nodes) }).list(FILTER);
  assert.deepEqual(found.map(d => d.productId).sort(), [...P.PRODUCT_IDS].sort());
});

test('a kernel without hidraw simply lists nothing', async () => {
  assert.deepEqual(await createHidLinux({ sysDir: path.join(tmpdir(), 'xenon-no-such-dir') }).list(FILTER), []);
});

// libc's ioctl as koffi hands it over: async only, buffer filled in place.
function fakeIoctl(answer = () => 64) {
  const calls = [];
  const ioctl = { async: (fd, request, buf, done) => { calls.push({ fd, request, buf: Buffer.from(buf) }); setImmediate(() => done(null, answer(buf, request))); } };
  return { calls, getIoctl: () => ioctl };
}

function opened(fake, file = { fd: 7, close: async () => {} }) {
  return createHidLinux({ openNode: async () => file, getIoctl: fake.getIoctl }).open({ path: '/dev/hidraw3', featureLength: 64 });
}

test('a feature report goes out through ioctl, 64 bytes, report id first', async () => {
  const fake = fakeIoctl();
  const dev = await opened(fake);
  await dev.setFeature(P.packet([P.CMD.INFO]));
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].fd, 7);
  assert.equal(fake.calls[0].request, 0xC0404806);
  assert.equal(fake.calls[0].buf.length, 64);
  assert.equal(fake.calls[0].buf[0], 0xCC);
  assert.equal(fake.calls[0].buf[1], P.CMD.INFO);
});

test('a short report is padded and a long one cut to the report size', async () => {
  const fake = fakeIoctl();
  const dev = await opened(fake);
  await dev.setFeature(Buffer.from([0xCC, 0x60]));
  await dev.setFeature(Buffer.alloc(100, 0x11));
  assert.deepEqual([...fake.calls[0].buf.subarray(0, 3)], [0xCC, 0x60, 0]);
  assert.equal(fake.calls[0].buf.length, 64);
  assert.equal(fake.calls[1].buf.length, 64);
});

test('reading a report asks for its id and returns what the kernel filled in', async () => {
  const fake = fakeIoctl((buf) => { buf[1] = 0x42; return 64; });
  const dev = await opened(fake);
  const reply = await dev.getFeature(0xCC);
  assert.equal(fake.calls[0].request, 0xC0404807);
  assert.equal(fake.calls[0].buf[0], 0xCC);
  assert.equal(reply[0], 0xCC);
  assert.equal(reply[1], 0x42);
});

test('a refused report is an error, in both directions', async () => {
  const dev = await opened(fakeIoctl(() => -1));
  await assert.rejects(dev.setFeature(Buffer.alloc(64)), /feature report refused/);
  await assert.rejects(dev.getFeature(0xCC), /feature report read failed/);
});

test('after close nothing reaches the device, and closing twice closes once', async () => {
  let closes = 0;
  const fake = fakeIoctl();
  const dev = await opened(fake, { fd: 7, close: async () => { closes++; } });
  await dev.close();
  await dev.close();
  assert.equal(closes, 1);
  await assert.rejects(dev.setFeature(Buffer.alloc(64)), /device closed/);
  await assert.rejects(dev.getFeature(0xCC), /device closed/);
  assert.equal(fake.calls.length, 0);
});

for (const code of ['EACCES', 'EPERM']) {
  test(`${code} on the node is reported as a missing permission, for the UI to explain`, async () => {
    const openNode = async () => { throw Object.assign(new Error(code), { code }); };
    await assert.rejects(createHidLinux({ openNode, getIoctl: fakeIoctl().getIoctl }).open({ path: '/dev/hidraw3' }), /^Error: no-permission$/);
  });
}

test('any other failure to open stays a plain error', async () => {
  const openNode = async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
  await assert.rejects(createHidLinux({ openNode, getIoctl: fakeIoctl().getIoctl }).open({ path: '/dev/hidraw3' }), /could not open the USB device/);
});

test('a USB call that never returns frees the caller', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stuck = boundedCall({ async: () => {} });
  t.mock.timers.tick(2000);
  await assert.rejects(stuck, /HID call timed out/);
});

test('the name a device gives itself, and none when it gives none', () => {
  assert.equal(parseHidName('HID_ID=0003:00003151:00004011\nHID_NAME=Akko 2.4G Wireless Keyboard\nHID_PHYS=usb\n'), 'Akko 2.4G Wireless Keyboard');
  assert.equal(parseHidName('HID_ID=0003:00003151:00004011\nHID_NAME=\n'), '');
  assert.equal(parseHidName(null), '');
});
