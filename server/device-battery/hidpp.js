'use strict';
// HID++ 2.0, the protocol Logitech's devices and receivers (Unifying, Bolt,
// LIGHTSPEED) speak on their vendor HID interface. That interface is the only way
// to their battery: Windows and macOS know nothing about a mouse behind a dongle.
//
// Read-only on purpose: every request here is a "get". Nothing sets a register or
// a feature, so a device stays exactly as G HUB or Logi Options+ configured it.
//
// A `link` is what a backend hands over: write(bytes) and read(timeoutMs), the
// latter resolving to one input report with its report id first, or null.

const LONG_REPORT = 0x11;
const LONG_REPORT_BYTES = 20;
const SOFTWARE_ID = 0x0A;         // tells our replies from G HUB's on a shared device
const DIRECT_INDEX = 0xFF;        // a device on its own cable or Bluetooth
const RECEIVER_SLOTS = [1, 2, 3, 4, 5, 6];
const ERROR_V2 = 0xFF;
const ERROR_V1 = 0x8F;
const REPLY_TIMEOUT_MS = 1500;      // a dozing mouse took 700 ms to wake; empty slots answer at once
const PING_TOKEN = 0x5A;

const ROOT_INDEX = 0;
const ROOT_GET_FEATURE = 0;
const ROOT_PING = 1;

const FEATURE_DEVICE_INFO = 0x0003;
const FEATURE_DEVICE_NAME = 0x0005;
const FEATURE_BATTERY_STATUS = 0x1000;
const FEATURE_BATTERY_VOLTAGE = 0x1001;
const FEATURE_UNIFIED_BATTERY = 0x1004;
const INFO_GET = 0;
const UNIT_ID_START = 1;
const UNIT_ID_END = 5;
const NAME_GET_LENGTH = 0;
const NAME_GET_CHARS = 1;
const UNIFIED_GET_STATUS = 1;
const STATUS_GET_LEVEL = 0;
const VOLTAGE_GET = 0;
const VOLTAGE_CHARGING_FLAG = 0x80;

const FALLBACK_NAME = 'Logitech device';

// Unified battery devices without a fuel gauge report only a band.
const LEVEL_BANDS = [[8, 90], [4, 50], [2, 20], [1, 5]];

// Discharge curve of the Li-ion cell in these mice, millivolts to percent. Devices
// with the voltage feature report nothing else, so their percent is an estimate.
const VOLTAGE_CURVE = [
  [4186, 100], [4067, 90], [3989, 80], [3922, 70], [3859, 60], [3811, 50],
  [3778, 40], [3751, 30], [3717, 20], [3671, 10], [3646, 5], [3579, 2], [3500, 0],
];

function request(index, featureIndex, fn, params = []) {
  const bytes = Buffer.alloc(LONG_REPORT_BYTES);
  bytes[0] = LONG_REPORT;
  bytes[1] = index;
  bytes[2] = featureIndex;
  bytes[3] = (fn << 4) | SOFTWARE_ID;
  Buffer.from(params).copy(bytes, 4);
  return bytes;
}

// { data } for our reply, { error } for a refusal, null for anyone else's traffic.
function matchReply(report, index, featureIndex, fn) {
  if (!report || report.length < 6 || report[1] !== index) return null;
  const tag = (fn << 4) | SOFTWARE_ID;
  if (report[2] === ERROR_V2 && report[3] === featureIndex && report[4] === tag) return { error: report[5] };
  if (report[2] === ERROR_V1 && report[3] === featureIndex) return { error: report[5] };
  if (report[2] === featureIndex && report[3] === tag) return { data: report.subarray(4) };
  return null;
}

function createAsk(link, timeoutMs = REPLY_TIMEOUT_MS) {
  return async function ask(index, featureIndex, fn, params) {
    await link.write(request(index, featureIndex, fn, params));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return { error: 'timeout' };
      const reply = matchReply(await link.read(left), index, featureIndex, fn);
      if (reply) return reply;
    }
  };
}

function percentFromLevel(level) {
  const band = LEVEL_BANDS.find(([bit]) => level & bit);
  return band ? band[1] : null;
}

// 0 discharging, 1 charging, 2 charging slowly, 3 full, anything above is a fault.
function decodeUnifiedBattery(data) {
  const percent = data[0] || percentFromLevel(data[1]);
  if (percent == null || percent > 100) return null;
  return { percent, charging: data[2] >= 1 && data[2] <= 3 };
}

// 0 discharging, 1 to 4 on the charger, anything above is a fault.
function decodeBatteryStatus(data) {
  if (!data[0] || data[0] > 100) return null;
  return { percent: data[0], charging: data[2] >= 1 && data[2] <= 4 };
}

function percentFromVoltage(millivolts) {
  if (millivolts >= VOLTAGE_CURVE[0][0]) return 100;
  for (let i = 1; i < VOLTAGE_CURVE.length; i++) {
    const [highMv, highPct] = VOLTAGE_CURVE[i - 1];
    const [lowMv, lowPct] = VOLTAGE_CURVE[i];
    if (millivolts >= lowMv) return Math.round(lowPct + ((millivolts - lowMv) / (highMv - lowMv)) * (highPct - lowPct));
  }
  return 0;
}

function decodeBatteryVoltage(data) {
  const millivolts = data.readUInt16BE(0);
  if (!millivolts) return null;
  return { percent: percentFromVoltage(millivolts), charging: !!(data[2] & VOLTAGE_CHARGING_FLAG) };
}

const BATTERY_FEATURES = [
  { id: FEATURE_UNIFIED_BATTERY, fn: UNIFIED_GET_STATUS, decode: decodeUnifiedBattery },
  { id: FEATURE_BATTERY_STATUS, fn: STATUS_GET_LEVEL, decode: decodeBatteryStatus },
  { id: FEATURE_BATTERY_VOLTAGE, fn: VOLTAGE_GET, decode: decodeBatteryVoltage },
];

async function featureIndex(ask, index, id) {
  const reply = await ask(index, ROOT_INDEX, ROOT_GET_FEATURE, [id >> 8, id & 0xFF]);
  return (reply.data && reply.data[0]) || 0;
}

async function readLevel(ask, index) {
  for (const feature of BATTERY_FEATURES) {
    const at = await featureIndex(ask, index, feature.id);
    if (!at) continue;
    const reply = await ask(index, at, feature.fn);
    const level = reply.data ? feature.decode(reply.data) : null;
    if (level) return level;
  }
  return null;
}

async function readName(ask, index) {
  const at = await featureIndex(ask, index, FEATURE_DEVICE_NAME);
  if (!at) return FALLBACK_NAME;
  const size = await ask(index, at, NAME_GET_LENGTH);
  if (!size.data) return FALLBACK_NAME;
  let name = '';
  while (name.length < size.data[0]) {
    const part = await ask(index, at, NAME_GET_CHARS, [name.length]);
    const text = part.data ? part.data.toString('latin1').replace(/\0.*$/s, '') : '';
    if (!text) break;
    name += text;
  }
  return name.slice(0, size.data[0]).trim() || FALLBACK_NAME;
}

// Its own serial: two mice of one model have the same name, wherever they are plugged in.
async function readUnit(ask, index) {
  const at = await featureIndex(ask, index, FEATURE_DEVICE_INFO);
  if (!at) return null;
  const reply = await ask(index, at, INFO_GET);
  const unit = reply.data ? reply.data.subarray(UNIT_ID_START, UNIT_ID_END) : null;
  return unit && unit.some(Boolean) ? unit.toString('hex') : null;
}

// Protocol 2.0 and up answers a ping with its version and our token. A receiver
// (HID++ 1.0) and a device that is off or asleep answer with an error instead.
async function speaksHidpp2(ask, index) {
  const pong = await ask(index, ROOT_INDEX, ROOT_PING, [0, 0, PING_TOKEN]);
  return !!(pong.data && pong.data[0] >= 2 && pong.data[2] === PING_TOKEN);
}

async function readDevice(ask, index) {
  if (!(await speaksHidpp2(ask, index))) return null;
  const level = await readLevel(ask, index);
  if (!level) return null;
  const unit = await readUnit(ask, index);
  return { name: await readName(ask, index), ...level, ...(unit ? { unit } : {}) };
}

// Everything with a battery behind one link: the device itself, or a receiver's slots.
async function readLink(link) {
  const ask = createAsk(link);
  if (await speaksHidpp2(ask, DIRECT_INDEX)) {
    const device = await readDevice(ask, DIRECT_INDEX);
    return device ? [device] : [];
  }
  const devices = [];
  for (const slot of RECEIVER_SLOTS) {
    const device = await readDevice(ask, slot);
    if (device) devices.push(device);
  }
  return devices;
}

module.exports = {
  LONG_REPORT_BYTES, request, matchReply, createAsk, percentFromVoltage,
  decodeUnifiedBattery, decodeBatteryStatus, decodeBatteryVoltage, readLink,
};
