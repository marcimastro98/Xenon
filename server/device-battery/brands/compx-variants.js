'use strict';
// Mice on Compx chips that do not use the 17-byte frame of compx.js.

const { ids, reading, validPercent } = require('./ids');

// The cable has a frame of its own, but its level is not reliable: dongles only.
const ATK_REPORT = 0x08;
const ATK_REQUEST = [ATK_REPORT, 0x7D, 0x72, 0x02, 0x00, 0x01, 0x07, 0x01];
const ATK_WAIT_MS = 500;

async function readAtkZero(io) {
  const r = await io.ask(ATK_REQUEST, (x) => x[0] === ATK_REPORT && x[1] === 0x72 && x[5] === 0x07, ATK_WAIT_MS);
  return r ? reading(validPercent(r[7])) : [];
}

// The XS-1 protocol, as mousebatt (MIT) reads it: a 64-byte frame behind report id 0 that
// ends in a 16-bit sum. The source polls for the answer, and a second request would only
// restart the trip, so this waits once. A mouse still pending gives no reading.
const XS1_BYTES = 64;
const XS1_SUM_AT = XS1_BYTES - 2;
const XS1_ANSWER = 0x01;
const XS1_BATTERY = [0x08, 0x81, 0x01];
const XS1_CHARGING = [0x08, 0x83, 0x01];
const XS1_WAIT_MS = 500;
const AT_XS1_VALUE = 6;

const xs1Sum = (frame) => frame.subarray(0, XS1_SUM_AT).reduce((sum, b) => (sum + b) & 0xFFFF, 0);

function xs1Request(command) {
  const report = Buffer.alloc(1 + XS1_BYTES);
  const frame = report.subarray(1);
  Buffer.from(command).copy(frame, 1);
  frame.writeUInt16LE(xs1Sum(frame), XS1_SUM_AT);
  return report;
}

async function askXs1(io, command) {
  const frame = (await io.feature(xs1Request(command), 0, XS1_WAIT_MS)).subarray(1, 1 + XS1_BYTES);
  const isAnswer = frame.length === XS1_BYTES && frame[0] === XS1_ANSWER && frame[1] === command[0]
    && frame[2] === command[1] && frame.readUInt16LE(XS1_SUM_AT) === xs1Sum(frame);
  return isAnswer ? frame : null;
}

async function readXs1(io) {
  const level = await askXs1(io, XS1_BATTERY);
  const percent = level ? validPercent(level[AT_XS1_VALUE]) : null;
  if (percent === null) return [];
  const state = await askXs1(io, XS1_CHARGING);
  return [{ percent, charging: state ? state[AT_XS1_VALUE] !== 0 : null }];
}

module.exports = [
  { label: 'ATK Zero', products: ids(0x373B, [0x1155, 0x124F]), page: 0xFF05, usage: 1, size: 64, read: readAtkZero },
  { label: 'Pulsar XS-1', products: ids(0x3710, [0x5403, 0x3408]), page: 0xFFFF, usage: 1, usbInterface: 3, feature: true, size: 1 + XS1_BYTES, read: readXs1 },
];
