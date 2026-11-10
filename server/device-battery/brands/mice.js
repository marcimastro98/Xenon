'use strict';
// Smaller brands, each with a protocol a public tool read on real hardware.

const { ids, reading, validPercent } = require('./ids');

// Glorious, WLMouse and Lamzu Maya: one feature frame. Status 0xA4 is a mouse asleep.
const GLORIOUS_REQUEST = [0x00, 0x00, 0x00, 0x02, 0x02, 0x00, 0x83];
const GLORIOUS_WAIT_MS = 50;
const GLORIOUS_OK = new Set([0xA1, 0xA2]);
const GLORIOUS_BYTES = 65;

async function readGlorious(io) {
  const r = await io.feature(GLORIOUS_REQUEST, 0, GLORIOUS_WAIT_MS);
  if (!GLORIOUS_OK.has(r[1]) || r[4] !== 0x02 || r[6] !== 0x83) return [];
  return reading(validPercent(r[8]));
}

const VAXEE_REPORT = 0x0E;
const VAXEE_WAIT_MS = 100;
const VAXEE_STEP_PERCENT = 5;
const vaxeeFrame = (command) => [VAXEE_REPORT, 0xA5, command, 0x01, 0x01];

async function readVaxee(io) {
  const level = await io.feature(vaxeeFrame(0x0B), VAXEE_REPORT, VAXEE_WAIT_MS);
  const percent = validPercent(level[5] * VAXEE_STEP_PERCENT);
  if (percent === null) return [];
  const state = await io.feature(vaxeeFrame(0x10), VAXEE_REPORT, VAXEE_WAIT_MS);
  return [{ percent, charging: state[5] !== 0 }];
}

const NZXT_REPORT = 0x4E;
const NZXT_REQUEST = [NZXT_REPORT, 0x02, 0x81, 0x00, 0xB0];
const NZXT_REPLY = 0x97;
const NZXT_REPLY_BYTES = 23;

async function readNzxt(io) {
  const r = await io.ask(NZXT_REQUEST, (x) => x.length >= NZXT_REPLY_BYTES && x[0] === NZXT_REPORT && x[1] === 0x02 && x[2] === NZXT_REPLY);
  return r ? reading(validPercent(r.readUInt16LE(17)), (r[22] & 1) === 1) : [];
}

module.exports = [
  { label: 'Glorious wireless mouse', products: ids(0x258A, [0x2022, 0x2011, 0x2033, 0x2036, 0x2034, 0x201A]), feature: true, size: GLORIOUS_BYTES, read: readGlorious },
  { label: 'WLMouse Beast X Max', products: ids(0x36A7, [0xA880]), feature: true, size: GLORIOUS_BYTES, read: readGlorious },
  { label: 'Lamzu Maya X', products: ids(0x373E, [0x001E, 0x001C]), page: 0xFFFF, feature: true, size: GLORIOUS_BYTES, read: readGlorious },
  { label: 'VAXEE mouse', products: ids(0x3057, [0x1001, 0x1002, 0x2001, 0x2002]), page: 0xFF05, feature: true, read: readVaxee },
  { label: 'NZXT Lift Elite', products: ids(0x1E71, [0x2101, 0x2129]), page: 0xFFCA, usage: 1, size: 64, read: readNzxt },
];
