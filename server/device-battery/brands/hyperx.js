'use strict';
// HyperX headsets, under HP's vendor id. Each generation has its own frames.

const { ids, reading, validPercent } = require('./ids');

const HP = 0x03F0;

const CLOUD3_REPORT = 0x66;
const CLOUD3_BATTERY = 0x89;
const CLOUD3_CHARGING = 0x8A;
const CLOUD3_PUSHED = { [CLOUD3_BATTERY]: 0x0D, [CLOUD3_CHARGING]: 0x0C };

const cloud3Answer = (command) => (r) => r[0] === CLOUD3_REPORT && (r[1] === command || r[1] === CLOUD3_PUSHED[command]);

async function readCloud3(io) {
  const reply = await io.ask([CLOUD3_REPORT, CLOUD3_BATTERY], cloud3Answer(CLOUD3_BATTERY));
  if (!reply || !(reply[2] || reply[3])) return [];
  const percent = validPercent(reply[4]);
  if (percent === null) return [];
  const state = await io.ask([CLOUD3_REPORT, CLOUD3_CHARGING], cloud3Answer(CLOUD3_CHARGING));
  return [{ percent, charging: state ? state[2] === 1 || state[2] === 2 : null }];
}

// Byte 3 has to stay 1: 0 there turns the same frame into a write.
const CLOUD3S_REPORT = 0x0C;
const CLOUD3S_BATTERY = 0x06;
const CLOUD3S_CHARGING = 0x48;
const NO_VALUE = 0xFF;
const cloud3sFrame = (command) => [CLOUD3S_REPORT, 0x02, 0x03, 0x01, 0x00, command];

async function readCloud3S(io) {
  const ask = (command) => io.ask(cloud3sFrame(command), (r) => r[0] === CLOUD3S_REPORT && r[5] === command);
  const reply = await ask(CLOUD3S_BATTERY);
  const percent = reply && reply[6] !== NO_VALUE ? validPercent(reply[6]) : null;
  if (percent === null) return [];
  const state = await ask(CLOUD3S_CHARGING);
  return [{ percent, charging: state && state[6] !== NO_VALUE ? state[6] !== 0 : null }];
}

async function readAlpha2(io) {
  const link = await io.ask([0x52, 0x01], (r) => r[0] === 0x53 && r[1] === 0x01);
  if (!link || !link[2]) return [];
  const reply = await io.ask([0x50, 0x02], (r) => r[0] === 0x51 && r[1] === 0x02);
  const percent = reply ? validPercent(reply[2]) : null;
  return percent === null ? [] : [{ percent, charging: reply[3] === 1 }];
}

const CLOUD2_HEADER = [0x06, 0xFF, 0xBB];
const CLOUD2_BATTERY = 0x02;
const CLOUD2_CHARGING = 0x03;
const cloud2Answer = (command) => (r) => CLOUD2_HEADER.every((b, i) => r[i] === b) && r[3] === command;

async function readCloud2(io) {
  const reply = await io.ask([...CLOUD2_HEADER, CLOUD2_BATTERY, 0x00], cloud2Answer(CLOUD2_BATTERY));
  const percent = reply ? validPercent(reply[7]) : null;
  if (percent === null) return [];
  const state = await io.ask([...CLOUD2_HEADER, CLOUD2_CHARGING, 0x00], cloud2Answer(CLOUD2_CHARGING));
  return [{ percent, charging: state ? state[4] === 1 : null }];
}

// Frames as in HyperHeadset (MIT). The headset answers with the command or its own code
// for the same thing, which is also what it pushes by itself.
const ALPHA_WIRELESS_HEADER = [0x21, 0xBB];
const ALPHA_WIRELESS_LINK = [0x03, 0x24];
const ALPHA_WIRELESS_BATTERY = [0x0B, 0x25];
const ALPHA_WIRELESS_CHARGING = [0x0C, 0x26];
const ALPHA_WIRELESS_OFF = 1;
const WAIT_MS = 500;

function askAlphaWireless(io, [command, code]) {
  const isAnswer = (r) => r[0] === ALPHA_WIRELESS_HEADER[0] && r[1] === ALPHA_WIRELESS_HEADER[1] && (r[2] === command || r[2] === code);
  return io.ask([...ALPHA_WIRELESS_HEADER, command], isAnswer, WAIT_MS);
}

async function readAlphaWireless(io) {
  const link = await askAlphaWireless(io, ALPHA_WIRELESS_LINK);
  if (!link || link[3] === ALPHA_WIRELESS_OFF) return [];
  const reply = await askAlphaWireless(io, ALPHA_WIRELESS_BATTERY);
  const percent = reply ? validPercent(reply[3]) : null;
  if (percent === null) return [];
  const state = await askAlphaWireless(io, ALPHA_WIRELESS_CHARGING);
  return [{ percent, charging: state ? state[3] === 1 : null }];
}

// Same frame as the Alpha 2, as waybar-hyperx-haste2 (MIT) reads it.
async function readHaste2(io) {
  const r = await io.ask([0x50, 0x02], (x) => x[0] === 0x51 && x[1] === 0x02, WAIT_MS);
  return r ? reading(validPercent(r[2])) : [];
}

module.exports = [
  { label: 'HyperX Cloud III Wireless', products: ids(HP, [0x05B7, 0x0C9D, 0x0995, 0x0795]), page: 0xFF13, usage: 1, size: 62, read: readCloud3 },
  { label: 'HyperX Cloud III S Wireless', products: ids(HP, [0x02CC, 0x06BE]), size: 64, read: readCloud3S },
  { label: 'HyperX Cloud Alpha 2 Wireless', products: ids(HP, [0x08BE]), page: 0xFF13, usage: 0xFF00, size: 64, read: readAlpha2 },
  { label: 'HyperX Cloud II Wireless', products: ids(HP, [0x0696, 0x018B]), page: 0xFF90, usage: 0x0303, size: 52, read: readCloud2 },
  { label: 'HyperX Cloud Alpha Wireless', products: ids(HP, [0x098D]), size: 31, read: readAlphaWireless },
  { label: 'HyperX Pulsefire Haste 2 Wireless', products: ids(HP, [0x0F98]), usbInterface: 2, size: 64, read: readHaste2 },
];
