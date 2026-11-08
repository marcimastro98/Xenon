'use strict';
// Corsair without iCUE. Only GET frames: the SET that puts a device in software mode
// takes it over, so nothing here may ever send one. Values are tenths of a percent.

const { ids } = require('./ids');

const CORSAIR = 0x1B1C;
const COMMAND_GET = 0x02;
const PROPERTY_LEVEL = 0x0F;
const PROPERTY_CHARGE = 0x10;
const TARGET_THROUGH_DONGLE = 0x09;
const HEADSET_REPORT = 0x02;
const HEADSET_REPLY = 0x01;
const STATE_CHARGING = 1;
const TENTHS = 10;
const MAX_TENTHS = 1000;
// Measured at about 4.7 s on a Dark Core: a mouse answers when its radio next wakes.
const SLOW_REPLY_MS = 6000;
const REPORT_BYTES = 64;

// The reply repeats the command and not the property, so iCUE's own traffic on the same
// dongle can pass for ours: a value counts only when asked twice and the same.
async function askTwice(io, request, isAnswer, value) {
  const first = await io.ask(request, isAnswer, SLOW_REPLY_MS);
  if (!first) return null;
  const second = await io.ask(request, isAnswer, SLOW_REPLY_MS);
  return second && value(first) === value(second) ? value(first) : null;
}

const percentOf = (tenths) => (tenths > 0 && tenths <= MAX_TENTHS ? Math.round(tenths / TENTHS) : null);

function bragiReader(frame, isAnswer, valueAt) {
  const value = (r) => r.readUInt16LE(valueAt);
  return async (io) => {
    const percent = percentOf(await askTwice(io, frame(PROPERTY_LEVEL), isAnswer, value));
    if (percent === null) return [];
    const state = await askTwice(io, frame(PROPERTY_CHARGE), isAnswer, value);
    return [{ percent, charging: state === null ? null : state === STATE_CHARGING }];
  };
}

const readPeripheral = bragiReader(
  (property) => [0x00, TARGET_THROUGH_DONGLE, COMMAND_GET, property],
  (r) => r[1] === COMMAND_GET && r[2] === 0,
  3,
);

const readHeadset = bragiReader(
  (property) => [HEADSET_REPORT, TARGET_THROUGH_DONGLE, COMMAND_GET, property],
  (r) => r[0] === HEADSET_REPLY && r[2] === COMMAND_GET && r[3] === 0,
  4,
);

const VOID_REQUEST = [0xC9, 0x64];
const VOID_REPLY = 0x64;
const VOID_LEVEL_BITS = 0x7F;
const VOID_DISCONNECTED = 0;
const VOID_FULL = 4;
const VOID_CHARGING = 5;

async function readVoid(io) {
  const reply = await io.ask(VOID_REQUEST, (r) => r[0] === VOID_REPLY);
  if (!reply || reply[4] === VOID_DISCONNECTED) return [];
  const percent = reply[2] & VOID_LEVEL_BITS;
  if (percent === 0 || percent > 100) return [];
  return [{ percent, charging: reply[4] === VOID_CHARGING || reply[4] === VOID_FULL }];
}

const SLIPSTREAM = [0x1B7F, 0x1B81, 0x1BA6, 0x1BDC, 0x2B00, 0x1BB5, 0x1BAC];
const HEADSETS = [0x0A97, 0x2A08, 0x2A02];
const VOIDS = [0x1B1C, 0x1B27, 0x0A14, 0x0A16, 0x0A17, 0x0A1D, 0x0A1A, 0x1B2A, 0x1B23, 0x1B29, 0x0A55, 0x0A51, 0x0A52, 0x0A38, 0x0A4F, 0x0A2B, 0x0A75, 0x0A56];

module.exports = [
  { vendor: 'corsair', label: 'Corsair wireless device', products: ids(CORSAIR, SLIPSTREAM), page: 0xFF42, size: REPORT_BYTES + 1, read: readPeripheral },
  { vendor: 'corsair', label: 'Corsair headset', products: ids(CORSAIR, HEADSETS), page: 0xFF42, usage: 1, size: REPORT_BYTES, read: readHeadset },
  { vendor: 'corsair', label: 'Corsair Void', products: ids(CORSAIR, VOIDS), page: 0xFFC5, usage: 1, size: REPORT_BYTES, read: readVoid },
];
