#!/usr/bin/env node
// A simulated GIGABYTE IT5711 on a real kernel: /dev/uhid turns this process into a
// HID device, so hidraw, sysfs and udev treat it like the chip, and every feature
// report the driver sends through its ioctl arrives here. It answers like the chip
// and writes down what it was told. Run as root (node fake-it5711.mjs <log file>).
import fs from 'node:fs';

const LOG = process.argv[2];

const UHID_GET_REPORT = 9;
const UHID_GET_REPORT_REPLY = 10;
const UHID_CREATE2 = 11;
const UHID_SET_REPORT = 13;
const UHID_SET_REPORT_REPLY = 14;
const BUS_USB = 3;
const VENDOR_ID = 0x048D;
const PRODUCT_ID = 0x5711;
const REPORT_ID = 0xCC;
const REPORT_BYTES = 64;
const CREATE_EVENT_BYTES = 4 + 128 + 64 + 64 + 2 + 2 + 4 * 4 + 4096;
const READ_BYTES = 8192;

// Usage page 0xFF89, usage 0xCC, one 63-byte feature report with id 0xCC.
const DESCRIPTOR = Buffer.from([
  0x06, 0x89, 0xFF, 0x09, 0xCC, 0xA1, 0x01,
  0x85, REPORT_ID, 0x09, 0x01, 0x15, 0x00, 0x26, 0xFF, 0x00, 0x75, 0x08, 0x95, 0x3F, 0xB1, 0x02,
  0xC0,
]);

const CALIBRATION = 0x10002;   // the usual GRB

function reply(fill) {
  const b = Buffer.alloc(REPORT_BYTES);
  b[0] = REPORT_ID;
  if (fill) fill(b);
  return b;
}

const INFO = reply((b) => {
  b[3] = 1;                                        // strip detection
  [1, 0, 19, 6].forEach((v, i) => { b[4 + i] = v; });   // firmware
  b[11] = 0x03;                                    // Gen2, Dynamic Lighting
  b.write('IT5711-SIMULATED', 12, 'latin1');
  b.writeUInt32LE(CALIBRATION, 44);
  b.writeUInt32LE(CALIBRATION, 48);
  b.writeUInt32LE(0x57110001, 56);
});
const INFO_EXTRA = reply((b) => { for (let i = 0; i < 4; i++) b.writeUInt32LE(CALIBRATION, 4 + i * 4); });
const ANSWERS = { 0x60: INFO, 0x61: INFO_EXTRA };

const fd = fs.openSync('/dev/uhid', 'r+');
let lastCommand = 0;

const note = (entry) => fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...entry }) + '\n');

function send(event) { fs.writeSync(fd, event); }

function create() {
  const ev = Buffer.alloc(CREATE_EVENT_BYTES);
  ev.writeUInt32LE(UHID_CREATE2, 0);
  ev.write('ITE Tech. Inc. GIGABYTE Device', 4, 'latin1');
  let o = 4 + 128 + 64 + 64;
  ev.writeUInt16LE(DESCRIPTOR.length, o); o += 2;
  ev.writeUInt16LE(BUS_USB, o); o += 2;
  ev.writeUInt32LE(VENDOR_ID, o); o += 4;
  ev.writeUInt32LE(PRODUCT_ID, o); o += 8;         // product, then version 0
  o += 4;                                          // country
  DESCRIPTOR.copy(ev, o);
  send(ev);
}

function onSetReport(ev) {
  const id = ev.readUInt32LE(4);
  const size = ev.readUInt16LE(10);
  const data = ev.subarray(12, 12 + size);
  note({ set: data.toString('hex'), rnum: ev[8], rtype: ev[9], size });
  lastCommand = data[1];
  const out = Buffer.alloc(10);
  out.writeUInt32LE(UHID_SET_REPORT_REPLY, 0);
  out.writeUInt32LE(id, 4);
  send(out);
}

function onGetReport(ev) {
  const id = ev.readUInt32LE(4);
  note({ get: ev[8], rtype: ev[9], after: lastCommand });
  const data = ANSWERS[lastCommand] || reply();
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32LE(UHID_GET_REPORT_REPLY, 0);
  out.writeUInt32LE(id, 4);
  out.writeUInt16LE(data.length, 10);
  data.copy(out, 12);
  send(out);
}

function readNext() {
  const buf = Buffer.alloc(READ_BYTES);
  fs.read(fd, buf, 0, READ_BYTES, null, (err, n) => {
    if (err) throw err;
    const type = n >= 4 ? buf.readUInt32LE(0) : -1;
    if (type === UHID_SET_REPORT) onSetReport(buf);
    else if (type === UHID_GET_REPORT) onGetReport(buf);
    readNext();
  });
}

create();
readNext();
