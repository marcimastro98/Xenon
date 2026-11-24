// tools/link-capture: a USBPcap file read back as records, the hub found by its device
// descriptor, its reports read as commands in the hub's language. The capture is built here,
// byte by byte, with invented values: no real capture is ever kept in the repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCapture, addressOf, reportsOf } from '../../tools/link-capture/pcap.mjs';
import { commandOf, timeline, writes, triples } from '../../tools/link-capture/link-decode.mjs';
import { markerLeds } from '../../tools/link-capture/colours.mjs';

const TRANSFER = { interrupt: 1, control: 2 };

// One USBPcap packet: its 27-byte header (28 with a control stage), then the data.
function usbPacket({ device, endpoint, transfer, fromDevice, data, stage = null }) {
  const len = stage === null ? 27 : 28;
  const h = Buffer.alloc(len);
  h.writeUInt16LE(len, 0);
  h[16] = fromDevice ? 1 : 0;
  h.writeUInt16LE(1, 17);
  h.writeUInt16LE(device, 19);
  h[21] = endpoint;
  h[22] = TRANSFER[transfer];
  h.writeUInt32LE(data.length, 23);
  if (stage !== null) h[27] = stage;
  return Buffer.concat([h, data]);
}

function pcapOf(packets) {
  const g = Buffer.alloc(24);
  g.writeUInt32LE(0xa1b2c3d4, 0);
  g.writeUInt16LE(2, 4);
  g.writeUInt16LE(4, 6);
  g.writeUInt32LE(65535, 16);
  g.writeUInt32LE(249, 20);
  const parts = [g];
  packets.forEach((p, i) => {
    const r = Buffer.alloc(16);
    r.writeUInt32LE(1000, 0);
    r.writeUInt32LE(i * 40000, 4);
    r.writeUInt32LE(p.length, 8);
    r.writeUInt32LE(p.length, 12);
    parts.push(r, p);
  });
  return Buffer.concat(parts);
}

function descriptor(vid, pid) {
  const d = Buffer.alloc(18);
  d[0] = 18;
  d[1] = 1;
  d.writeUInt16LE(vid, 8);
  d.writeUInt16LE(pid, 10);
  return d;
}

// A report as a program writes it to the hub: 00 01, the command, zeros to 512 bytes.
function report(cmd) {
  const b = Buffer.alloc(512);
  b[1] = 0x01;
  Buffer.from(cmd).copy(b, 2);
  return b;
}

const HUB = 7;
const MOUSE = 3;
const colours = [0xff, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff];
const writeCmd = [0x06, 0x01, colours.length + 2, 0x00, 0x00, 0x00, 0x12, 0x00, ...colours];
const capture = pcapOf([
  usbPacket({ device: MOUSE, endpoint: 0x80, transfer: 'control', fromDevice: true, stage: 3, data: descriptor(0x046d, 0xc077) }),
  usbPacket({ device: HUB, endpoint: 0x80, transfer: 'control', fromDevice: true, stage: 3, data: descriptor(0x1b1c, 0x0c3f) }),
  usbPacket({ device: MOUSE, endpoint: 0x81, transfer: 'interrupt', fromDevice: true, data: Buffer.from([1, 2, 3]) }),
  usbPacket({ device: HUB, endpoint: 0x01, transfer: 'interrupt', fromDevice: false, data: report([0x01, 0x03, 0x00, 0x02]) }),
  usbPacket({ device: HUB, endpoint: 0x01, transfer: 'interrupt', fromDevice: false, data: report([0x0d, 0x01, 0x22]) }),
  usbPacket({ device: HUB, endpoint: 0x01, transfer: 'interrupt', fromDevice: false, data: report(writeCmd) }),
  usbPacket({ device: HUB, endpoint: 0x01, transfer: 'interrupt', fromDevice: false, data: report(writeCmd) }),
  usbPacket({ device: HUB, endpoint: 0x82, transfer: 'interrupt', fromDevice: true, data: Buffer.from([0x00, 0x00, 0x06, 0x00, 0x12, 0x00]) }),
  usbPacket({ device: HUB, endpoint: 0x01, transfer: 'interrupt', fromDevice: false, data: report([0x05, 0x01, 0x01, 0x22]) }),
]);

test('link capture: the hub is found by its ids and only its reports are kept, both ways', () => {
  const records = readCapture(capture);
  assert.equal(records.length, 9);
  const at = addressOf(records, 0x1b1c, 0x0c3f);
  assert.equal(at, `1.${HUB}`);
  const reports = reportsOf(records, at);
  assert.deepEqual(reports.map((r) => r.out), [true, true, true, true, false, true]);
  assert.equal(addressOf(records, 0x1b1c, 0x0c4e), null);
});

test('link capture: reports read as commands, the write named with the endpoint it went to', () => {
  assert.equal(commandOf(report([0x01, 0x03, 0x00, 0x02])).name, 'software');
  assert.deepEqual(commandOf(report([0x0d, 0x01, 0x22])), { name: 'open', ep: 0x22, bytes: Buffer.from([0x0d, 0x01, 0x22]) });
  const w = commandOf(report(writeCmd));
  assert.equal(w.name, 'write');
  assert.deepEqual(w.type, [0x12, 0x00]);
  assert.deepEqual([...w.payload], colours);
  assert.match(commandOf(report([0x0a, 0x01, 0x05])).name, /^op 0a$/);
  const reports = reportsOf(readCapture(capture), `1.${HUB}`);
  const lines = timeline(reports);
  assert.equal(lines.length, 4, lines.join('\n'));
  assert.match(lines[2], /write to ep 22 type 12 00 \(9 bytes\) ff 00 00 ff 00 00 00 00 ff\s+x2$/);
  assert.equal(timeline(reports, { answers: true }).length, 5);
});

test('link capture: writes grouped by endpoint and type, each payload once, as colours', () => {
  const groups = writes(reportsOf(readCapture(capture), `1.${HUB}`));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'ep 22 type 12 00');
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].distinct.length, 1);
  assert.equal(triples(groups[0].distinct[0].payload), 'ff0000 x2, 0000ff');
  assert.equal(triples(Buffer.from([1, 2, 3, 4])), '010203 +1 bytes');
});

test('link capture: the marker step gives every LED a colour naming its part and place', () => {
  const leds = markerLeds([{ kind: 'pump', ledIds: [11, 12] }, { kind: 'fan', ledIds: [21] }]);
  assert.deepEqual(leds, { 11: '#100055', 12: '#100455', 21: '#200055' });
  assert.equal(new Set(Object.values(markerLeds([{ ledIds: Array.from({ length: 40 }, (_, i) => i) }, { ledIds: [100, 101] }]))).size, 42);
});

test('link capture: a file that is not a USBPcap capture is refused', () => {
  assert.throws(() => readCapture(Buffer.alloc(10)), /too short/);
  const other = Buffer.from(capture);
  other.writeUInt32LE(1, 20);
  assert.throws(() => readCapture(other), /link type 1/);
});
