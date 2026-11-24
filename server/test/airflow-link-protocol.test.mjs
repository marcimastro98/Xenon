// The iCUE LINK hub's language (server/airflow/corsair-link-protocol.js), the device
// table (corsair-link-devices.js) and one conversation (corsair-link-session.js) on a
// stand-in hub that keeps a real hub's state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeLinkHub, deviceEntry, EMPTY, readingsData } from './airflow-link-fake.mjs';

const require = createRequire(import.meta.url);
const P = require('../airflow/corsair-link-protocol.js');
const { linkDevice } = require('../airflow/corsair-link-devices.js');
const { createLinkSession } = require('../airflow/corsair-link-session.js');

const replyOf = (op, status, type, data) => {
  const raw = Buffer.alloc(512);
  raw[2] = op; raw[3] = status; raw[4] = type[0]; raw[5] = type[1];
  Buffer.from(data).copy(raw, 6);
  return raw;
};

test('a command is report id 0, then 00 01, then its bytes, 513 bytes in all', () => {
  const b = P.packet(P.COMMAND.software());
  assert.equal(b.length, 513);
  assert.deepEqual([...b.subarray(0, 7)], [0x00, 0x00, 0x01, 0x01, 0x03, 0x00, 0x02]);
  assert.deepEqual(P.COMMAND.hardware(), [0x01, 0x03, 0x00, 0x01]);
  assert.deepEqual(P.COMMAND.open(0x17), [0x0d, 0x01, 0x17]);
  assert.deepEqual(P.COMMAND.close(0x17), [0x05, 0x01, 0x01, 0x17]);
  assert.throws(() => P.packet(new Array(511).fill(0)), RangeError);
});

test('a write carries its length (data + 2), two zeros, the data type, then the data', () => {
  assert.deepEqual(P.COMMAND.write([0x07, 0x00], [1, 2, 0, 50, 0]), [0x06, 0x01, 7, 0, 0, 0, 0x07, 0x00, 1, 2, 0, 50, 0]);
});

test('a reply gives its echo, status, data type and data; too short is nothing', () => {
  const r = P.reply(replyOf(0x08, 0, [0x25, 0x00], [3]));
  assert.equal(r.op, 0x08);
  assert.equal(r.status, 0);
  assert.deepEqual(r.type, [0x25, 0x00]);
  assert.equal(r.data[0], 3);
  assert.equal(P.reply(Buffer.alloc(5)), null);
  assert.equal(P.reply('nope'), null);
});

test('the firmware reads major, minor and a 16-bit patch', () => {
  const raw = Buffer.alloc(16);
  raw[4] = 3; raw[5] = 11; raw.writeUInt16LE(646, 6);
  assert.deepEqual(P.firmwareOf(raw), { major: 3, minor: 11, patch: 646, text: '3.11.646' });
  assert.equal(P.firmwareOf(Buffer.alloc(7)), null);
});

test('the device list skips empty channels and joins the second read', () => {
  const list = [4, ...deviceEntry(0x07, 0x02, 'PUMPA'), ...EMPTY, ...deviceEntry(0x01, 0, 'FANB'), ...deviceEntry(0x13, 0, 'FANC')];
  const whole = P.parseDevices(replyOf(0x08, 0, [0x21, 0], list));
  assert.deepEqual(whole, [
    { channel: 1, type: 0x07, model: 0x02, id: 'PUMPA' },
    { channel: 3, type: 0x01, model: 0, id: 'FANB' },
    { channel: 4, type: 0x13, model: 0, id: 'FANC' },
  ]);
  // The same list cut in two: the rest comes in a second reply, its data from [4].
  const cut = 20;
  const first = Buffer.alloc(6 + cut);
  Buffer.from(list.slice(0, cut)).copy(first, 6);
  const rest = Buffer.alloc(512);
  Buffer.from(list.slice(cut)).copy(rest, 4);
  assert.deepEqual(P.parseDevices(first, rest), whole);
});

test('a device id stops at anything that is not printable, and a cut list keeps what is whole', () => {
  const d = P.parseDevices(replyOf(0x08, 0, [0x21, 0], [1, 0, 0, 0x01, 0, 0, 0, 0, 6, 0x41, 0x42, 0x00, 0x43, 0x44, 0x45]));
  assert.deepEqual(d, [{ channel: 1, type: 1, model: 0, id: 'AB' }]);
  assert.deepEqual(P.parseDevices(Buffer.alloc(6)), []);
  // A last channel number beyond 24 is capped.
  const many = P.parseDevices(replyOf(0x08, 0, [0x21, 0], [200, ...Array.from({ length: 30 }, (_, i) => deviceEntry(1, 0, `F${i}`)).flat()]));
  assert.equal(many.length, 24);
});

test('readings: entry i is channel i, only the ones with a value, temperatures in tenths', () => {
  const raw = replyOf(0x08, 0, [0x25, 0], readingsData([null, 2400, 900, null]));
  assert.deepEqual([...P.parseReadings(raw, 1)], [[1, 2400], [2, 900]]);
  const t = replyOf(0x08, 0, [0x10, 0], readingsData([null, 312]));
  assert.deepEqual([...P.parseReadings(t, 10)], [[1, 31.2]]);
  assert.equal(P.parseReadings(Buffer.alloc(3), 1).size, 0);
});

test('a speed write is a count then channel, percent mode, value; percent clamped, channel checked', () => {
  assert.deepEqual(P.speedData([{ channel: 1, percent: 55.4 }, { channel: 13, percent: 140 }]), [2, 1, 0, 55, 0, 13, 0, 100, 0]);
  assert.deepEqual(P.speedData([{ channel: 2, percent: -5 }]), [1, 2, 0, 0, 0]);
  assert.throws(() => P.speedData([{ channel: 0, percent: 50 }]), RangeError);
  assert.throws(() => P.speedData([{ channel: 25, percent: 50 }]), RangeError);
});

test('the device table: fans, pumps with their radiator, the shared type, and the unknown never driven', () => {
  assert.deepEqual(linkDevice(0x01, 0), { kind: 'fan', name: 'QX fan', temp: true, known: true });
  assert.equal(linkDevice(0x07, 0x02).name, 'H150i pump');
  assert.equal(linkDevice(0x07, 0x02).kind, 'pump');
  assert.equal(linkDevice(0x07, 0x40).name, 'AIO pump');
  assert.equal(linkDevice(0x1a, 0x01).kind, 'pump');
  assert.equal(linkDevice(0x1a, 0x00).kind, 'fan');
  assert.equal(linkDevice(0x1a, 0x08).kind, 'other');
  assert.deepEqual(linkDevice(0x7f, 0), { kind: 'other', name: 'LINK device', temp: false, known: false });
});

test('a session reads the firmware, enters software mode and lists the chain in two reads', async () => {
  // A full chain: a pump then 23 fans, more than one reply's 506 data bytes.
  const ids = Array.from({ length: 24 }, (_, i) => `DEVICE${String(i).padStart(16, '0')}`);
  const hub = fakeLinkHub({ channels: ids.map((id, i) => deviceEntry(i ? 0x13 : 0x07, 0, id)) });
  const s = createLinkSession({ link: hub.link, leadingZero: true });
  assert.equal((await s.firmware()).text, '3.11.646');
  await s.software();
  assert.equal(hub.mode, 'software');
  const devices = await s.devices(true);
  assert.equal(devices.length, 24);
  assert.deepEqual(devices[0], { channel: 1, type: 0x07, model: 0, id: ids[0] });
  assert.deepEqual(devices[23], { channel: 24, type: 0x13, model: 0, id: ids[23] });
  // close, open, read, read, close: never a read on an endpoint left open by someone else.
  assert.deepEqual(hub.log.slice(-5).map((l) => l.slice(0, 2)), ['05', '0d', '08', '08', '05']);
  assert.equal(hub.open, null);
});

test('a session reads speeds and temperatures, and writes speeds the hub keeps', async () => {
  const hub = fakeLinkHub();
  const s = createLinkSession({ link: hub.link, leadingZero: true });
  await s.software();
  assert.deepEqual([...(await s.speeds())], [[1, 2400], [2, 900]]);
  assert.deepEqual([...(await s.temps())], [[1, 31.2], [2, 29]]);
  await s.setSpeeds([{ channel: 1, percent: 70 }, { channel: 2, percent: 35 }]);
  assert.deepEqual([...hub.speeds], [[1, 70], [2, 35]]);
});

test('a hub that left software mode is put back once, then the read goes through', async () => {
  const hub = fakeLinkHub();
  const s = createLinkSession({ link: hub.link, leadingZero: true });
  assert.equal(hub.mode, 'hardware');
  assert.deepEqual([...(await s.speeds())], [[1, 2400], [2, 900]]);
  assert.equal(hub.mode, 'software');
  await s.hardware();
  assert.equal(hub.mode, 'hardware');
});

test('stale reports are drained and a reply to another command is not taken as the answer', async () => {
  const hub = fakeLinkHub({ leadingZero: false });
  hub.stale.push(replyOf(0x08, 0, [0x25, 0], readingsData([null, 1])));
  const s = createLinkSession({ link: hub.link, leadingZero: false });
  await s.software();
  assert.deepEqual([...(await s.speeds())], [[1, 2400], [2, 900]]);
});

test('a hub that stops answering fails the call with a timeout, and the next call still runs', async () => {
  let t = 0;
  const hub = fakeLinkHub({ silentAfter: 1 });
  const s = createLinkSession({ link: { ...hub.link, read: async (ms) => { t += ms; return hub.link.read(); } }, leadingZero: true, now: () => t });
  await s.software();
  await assert.rejects(s.speeds(), (e) => e.code === 'timeout');
  hub.silent = false;
  assert.deepEqual([...(await s.speeds())], [[1, 2400], [2, 900]]);
});

test('two calls at once never mix their reports', async () => {
  const hub = fakeLinkHub();
  const s = createLinkSession({ link: hub.link, leadingZero: true });
  await s.software();
  const [a, b] = await Promise.all([s.speeds(), s.temps()]);
  assert.equal(a.get(1), 2400);
  assert.equal(b.get(1), 31.2);
});

test('a hub found back in hardware mode is taken again once and counted', async () => {
  const hub = fakeLinkHub();
  const s = createLinkSession({ link: hub.link, leadingZero: true });
  await s.software();
  await s.speeds();
  assert.equal(s.retakes(), 0);
  hub.mode = 'hardware';
  await s.speeds();
  assert.equal(s.retakes(), 1);
  assert.equal(hub.mode, 'software');
});

test('the mode is asked without changing it', async () => {
  const hub = fakeLinkHub();
  const s = createLinkSession({ link: hub.link, leadingZero: true });
  assert.equal(await s.mode(), 'hardware');
  assert.equal(hub.mode, 'hardware');
  await s.software();
  assert.equal(await s.mode(), 'software');
  assert.equal(hub.open, null);
});
