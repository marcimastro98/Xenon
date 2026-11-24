// The CORSAIR pump screen spoken to directly (pump-screen/lcd-corsair.js, lcd-link.js): a picture
// goes out as the reports iCUE sends (our own capture, 23 Nov 2026), only picture parts can ever be
// built or sent, the newest picture wins over one waiting, the last one is sent again while nothing
// new comes, and a failed write closes the link and says why. Fake HID only: nothing touches a device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Lcd = require('../pump-screen/lcd-corsair.js');
const { createLcdLink } = require('../pump-screen/lcd-link.js');

const PANEL = Lcd.panelOf(0x1b1c, 0x0c4e);
// A pretend JPEG: the markers a real one starts and ends with, bytes in between that count up.
const jpeg = (n, seed = 0) => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 7 + seed) & 0xff;
  b[0] = 0xff; b[1] = 0xd8; b[n - 2] = 0xff; b[n - 1] = 0xd9;
  return b;
};

test('a picture goes out as iCUE sends it: 02 05 00, last flag, part number, length, then the JPEG', () => {
  const pic = jpeg(2500);
  const reports = Lcd.pictureReports(pic);
  assert.equal(reports.length, 3);
  assert.ok(reports.every((r) => r.length === 1024));
  assert.deepEqual(reports.map((r) => [...r.subarray(0, 8)]), [
    [0x02, 0x05, 0x00, 0, 0, 0, 0xf8, 0x03],
    [0x02, 0x05, 0x00, 0, 1, 0, 0xf8, 0x03],
    [0x02, 0x05, 0x00, 1, 2, 0, 0xd4, 0x01],
  ], 'the headers of the capture: 1016 bytes a part, the rest in the last');
  assert.deepEqual(Buffer.concat(reports.map((r) => r.subarray(8, 8 + r.readUInt16LE(6)))), pic, 'the JPEG whole, in order');
  assert.ok(reports[2].subarray(8 + 468).every((b) => b === 0), 'the last part padded with zeros');
  assert.equal(Lcd.pictureReports(jpeg(1016)).length, 1, 'one part exactly');
  assert.equal(Lcd.pictureReports(jpeg(1016))[0][3], 1, 'and it is the last');
  assert.equal(Lcd.pictureReports(jpeg(1017)).length, 2);
});

test('only a JPEG of sane size becomes reports', () => {
  assert.throws(() => Lcd.pictureReports(Buffer.from('not a picture')), /not a JPEG/);
  assert.throws(() => Lcd.pictureReports(jpeg(Lcd.MAX_JPEG_BYTES + 1)), /too large/);
  assert.throws(() => Lcd.pictureReports(null), /not a JPEG/);
  const cut = jpeg(3000).subarray(0, 2000);
  assert.throws(() => Lcd.pictureReports(cut), /not a JPEG/, 'a picture cut short is not sent');
});

test('nothing but a picture part passes the check every report goes through', () => {
  for (const n of [4, 100, 1016, 1017, 5000, 53369, Lcd.MAX_JPEG_BYTES]) {
    assert.ok(Lcd.pictureReports(jpeg(n)).every(Lcd.isPictureReport), `a picture of ${n} bytes`);
  }
  const part = Lcd.pictureReports(jpeg(2000))[0];
  const with_ = (at, v) => { const r = Buffer.from(part); r[at] = v; return r; };
  // The feature report iCUE sends now and then, whose meaning is not known: never ours to send.
  const feature = Buffer.alloc(1024); feature.set([0x03, 0x19, 0x00, 0x01]);
  for (const [why, r] of [
    ['another report id', with_(0, 0x03)], ['another command', with_(1, 0x06)], ['another byte 2', with_(2, 0x01)],
    ['a flag that is not last/not last', with_(3, 2)], ['the unknown feature', feature], ['a short report', part.subarray(0, 64)],
    ['no data', (() => { const r = Buffer.from(part); r.writeUInt16LE(0, 6); return r; })()],
    ['more data than a part holds', (() => { const r = Buffer.from(part); r.writeUInt16LE(1017, 6); return r; })()],
    ['not a buffer', [...part]],
  ]) assert.equal(Lcd.isPictureReport(r), false, why);
  assert.equal(Lcd.panelOf(0x1b1c, 0x0c3f), null, 'the LINK hub is not a screen');
  assert.deepEqual(Lcd.PANELS.map((p) => p.productId), [0x0c4e], 'only ids seen in a capture of our own');
});

// A fake HID: the device's interfaces and a link that records what it was given.
function rig({ fail = null, gate = false } = {}) {
  const writes = [];
  const opened = [];
  const closed = [];
  const timers = [];
  let release = null;
  const hid = { list: async () => [{ path: 'in-only', outputLength: 0 }, { path: 'lcd', outputLength: 1024 }] };
  const openReports = async (ifaces) => {
    opened.push(ifaces.map((i) => i.path));
    return {
      async write(b) {
        if (gate) await new Promise((r) => { release = r; });
        if (fail && fail(writes.length)) throw new Error('the device did not take the report');
        writes.push(b);
      },
      async close() { closed.push(true); },
    };
  };
  const errors = [];
  const link = createLcdLink({
    panel: PANEL, hid, openReports, onError: (e) => errors.push(e.message),
    setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: (id) => { timers[id - 1] = null; },
  });
  const settle = () => new Promise((r) => setImmediate(r));
  return { link, writes, opened, closed, timers, errors, settle, release: () => release && release() };
}

test('a picture reaches the screen part by part, on the interface that takes the reports', async () => {
  const r = rig();
  r.link.show(jpeg(2500));
  await r.settle(); await r.settle();
  assert.deepEqual(r.opened, [['lcd']]);
  assert.deepEqual(r.writes.map((w) => [w[3], w[4]]), [[0, 0], [0, 1], [1, 2]]);
  assert.ok(r.link.isOpen());
});

test('the newest picture wins over one waiting; the last is sent again while nothing new comes', async () => {
  const r = rig({ gate: true });
  r.link.show(jpeg(500, 1));
  await r.settle(); await r.settle();
  r.link.show(jpeg(500, 2));
  r.link.show(jpeg(500, 3));
  for (let i = 0; i < 6; i++) { r.release(); await r.settle(); await r.settle(); }
  assert.equal(r.writes.length, 2, 'the first, then the newest; the one in between is dropped');
  assert.deepEqual(r.writes[0].subarray(8, 508), jpeg(500, 1));
  assert.deepEqual(r.writes[1].subarray(8, 508), jpeg(500, 3));
  // Nothing new: the keeper sends the last picture again.
  r.timers.find(Boolean)();
  await r.settle(); r.release(); await r.settle(); await r.settle();
  assert.equal(r.writes.length, 3);
  assert.deepEqual(r.writes[2], r.writes[1]);
});

test('a write that fails closes the link and says why; the next picture opens it again', async () => {
  const r = rig({ fail: (n) => n === 1 });
  r.link.show(jpeg(2500));
  await r.settle(); await r.settle(); await r.settle();
  assert.deepEqual(r.errors, ['the device did not take the report']);
  assert.equal(r.closed.length, 1);
  assert.equal(r.link.isOpen(), false);
  r.timers.find(Boolean)();
  await r.settle();
  assert.equal(r.opened.length, 1, 'the keeper does not reopen a broken link on its own');
  r.link.show(jpeg(100));
  await r.settle(); await r.settle();
  assert.equal(r.opened.length, 2);
});

test('a report that is not a picture part never leaves, whatever built it', async () => {
  const real = Lcd.pictureReports;
  const feature = Buffer.alloc(1024);
  feature.set([0x03, 0x19, 0x00, 0x01]);
  Lcd.pictureReports = () => [Lcd.pictureReports === real ? null : real(jpeg(100))[0], feature].filter(Boolean);
  try {
    const r = rig();
    r.link.show(jpeg(100));
    await r.settle(); await r.settle();
    assert.equal(r.writes.length, 1, 'the picture part went, the feature did not');
    assert.deepEqual(r.errors, ['refused: not a picture part']);
  } finally { Lcd.pictureReports = real; }
});

test('closed: the keeper stops, the link is let go, and pictures go nowhere', async () => {
  const r = rig();
  r.link.show(jpeg(100));
  await r.settle(); await r.settle();
  await r.link.close();
  assert.equal(r.closed.length, 1);
  assert.deepEqual(r.timers.filter(Boolean), []);
  r.link.show(jpeg(100));
  await r.settle();
  assert.equal(r.writes.length, 1);
});

test('no screen plugged in: said, never thrown at the caller', async () => {
  const errors = [];
  const link = createLcdLink({ panel: PANEL, hid: { list: async () => [] }, openReports: async () => { throw new Error('unreachable'); }, onError: (e) => errors.push(e.message), setTimer: () => 1, clearTimer: () => {} });
  link.show(jpeg(100));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(errors, ['the pump screen is not plugged in']);
});
