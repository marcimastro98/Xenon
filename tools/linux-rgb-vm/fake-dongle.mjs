#!/usr/bin/env node
// Simulated 2.4 GHz receivers on a real kernel: /dev/uhid makes each a HID device, so
// hidraw, sysfs and udev treat it like the hardware. Each one writes down every report it
// gets, which is how the run proves what was sent and to whom. Run as root
// (node fake-dongle.mjs <log file>).
import fs from 'node:fs';

const LOG = process.argv[2];

const UHID_OUTPUT = 6;
const UHID_GET_REPORT = 9;
const UHID_GET_REPORT_REPLY = 10;
const UHID_CREATE2 = 11;
const UHID_INPUT2 = 12;
const UHID_SET_REPORT = 13;
const UHID_SET_REPORT_REPLY = 14;
const BUS_USB = 3;
const CREATE_EVENT_BYTES = 4 + 128 + 64 + 64 + 2 + 2 + 4 * 4 + 4096;
const READ_BYTES = 8192;
const OUTPUT_SIZE_AT = 4 + 4096;

// Page 0xFFFF, usage 2, one 64-byte feature report with no id: the Akko's vendor collection.
const FEATURE_DESCRIPTOR = Buffer.from([
  0x06, 0xFF, 0xFF, 0x09, 0x02, 0xA1, 0x01,
  0x09, 0x01, 0x15, 0x00, 0x26, 0xFF, 0x00, 0x75, 0x08, 0x95, 0x40, 0xB1, 0x02,
  0xC0,
]);

// Page 0xFF43, usage 0x0202, report 0x11 with 19 bytes in and out: a Logitech headset dongle.
const HIDPP_DESCRIPTOR = Buffer.from([
  0x06, 0x43, 0xFF, 0x0A, 0x02, 0x02, 0xA1, 0x01,
  0x85, 0x11, 0x75, 0x08, 0x95, 0x13, 0x15, 0x00, 0x26, 0xFF, 0x00,
  0x09, 0x02, 0x81, 0x00, 0x09, 0x02, 0x91, 0x00,
  0xC0,
]);

// uhid hands the report back as it stands, so the leading 0 of a report with no id is
// written here; usbhid adds it itself on a real dongle.
function akkoReply() {
  const reply = Buffer.alloc(65);
  reply[1] = 0xF7;
  reply[2] = 28;      // keyboard charge
  reply[5] = 1;       // no mouse paired
  return reply;
}

function headsetReply(request) {
  const reply = Buffer.alloc(20);
  request.copy(reply, 0, 0, 4);
  reply.writeUInt16BE(3830, 4);   // millivolts: 50% on the PRO curve
  return reply;
}

const DEVICES = [
  { name: 'Akko 2.4G Wireless Keyboard', vendor: 0x3151, product: 0x4011, descriptor: FEATURE_DESCRIPTOR, feature: akkoReply },
  { name: 'Logitech PRO X Wireless Gaming Headset', vendor: 0x046D, product: 0x0AAA, descriptor: HIDPP_DESCRIPTOR, output: headsetReply },
  { name: 'Silent receiver', vendor: 0x3151, product: 0x4014, descriptor: FEATURE_DESCRIPTOR, silent: true },
  { name: 'Not in the table', vendor: 0x3151, product: 0xFFF0, descriptor: FEATURE_DESCRIPTOR, feature: akkoReply },
];

const note = (device, entry) => fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), device: device.name, ...entry }) + '\n');

function create(fd, device) {
  const ev = Buffer.alloc(CREATE_EVENT_BYTES);
  ev.writeUInt32LE(UHID_CREATE2, 0);
  ev.write(device.name, 4, 'latin1');
  let o = 4 + 128 + 64 + 64;
  ev.writeUInt16LE(device.descriptor.length, o); o += 2;
  ev.writeUInt16LE(BUS_USB, o); o += 2;
  ev.writeUInt32LE(device.vendor, o); o += 4;
  ev.writeUInt32LE(device.product, o); o += 8;     // product, then version 0
  o += 4;                                          // country
  device.descriptor.copy(ev, o);
  fs.writeSync(fd, ev);
}

function onSetReport(fd, device, ev) {
  const size = ev.readUInt16LE(10);
  note(device, { set: ev.subarray(12, 12 + size).toString('hex') });
  if (device.silent) return;
  const out = Buffer.alloc(10);
  out.writeUInt32LE(UHID_SET_REPORT_REPLY, 0);
  out.writeUInt32LE(ev.readUInt32LE(4), 4);
  fs.writeSync(fd, out);
}

function onGetReport(fd, device, ev) {
  note(device, { get: ev[8] });
  if (device.silent) return;
  const data = device.feature();
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32LE(UHID_GET_REPORT_REPLY, 0);
  out.writeUInt32LE(ev.readUInt32LE(4), 4);
  out.writeUInt16LE(data.length, 10);
  data.copy(out, 12);
  fs.writeSync(fd, out);
}

function onOutput(fd, device, ev) {
  const request = ev.subarray(4, 4 + ev.readUInt16LE(OUTPUT_SIZE_AT));
  note(device, { out: request.toString('hex') });
  if (!device.output) return;
  const data = device.output(request);
  const input = Buffer.alloc(6 + data.length);
  input.writeUInt32LE(UHID_INPUT2, 0);
  input.writeUInt16LE(data.length, 4);
  data.copy(input, 6);
  fs.writeSync(fd, input);
}

const HANDLERS = { [UHID_SET_REPORT]: onSetReport, [UHID_GET_REPORT]: onGetReport, [UHID_OUTPUT]: onOutput };

function listen(fd, device) {
  const buf = Buffer.alloc(READ_BYTES);
  fs.read(fd, buf, 0, READ_BYTES, null, (err, n) => {
    if (err) throw err;
    const handler = n >= 4 ? HANDLERS[buf.readUInt32LE(0)] : null;
    if (handler) handler(fd, device, buf);
    listen(fd, device);
  });
}

for (const device of DEVICES) {
  const fd = fs.openSync('/dev/uhid', 'r+');
  create(fd, device);
  listen(fd, device);
}
