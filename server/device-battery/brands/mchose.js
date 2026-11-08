'use strict';
// MCHOSE mice, frames as in HaloBattery (MIT). Each generation has its own. The M7 and L7
// are not here: public tools disagree on their offsets.

const { ids, reading, validPercent } = require('./ids');

const WAIT_MS = 500;

async function readG7(io) {
  const r = await io.ask([0x00, 0x55, 0x30, 0xA5, 0x0B, 0x2E, 0x01, 0x01, 0x01], (x) => x[0] === 0xAA && x[1] === 0x30, WAIT_MS);
  return r ? reading(validPercent(r[8]), r[9] !== 0) : [];
}

async function readX9(io) {
  const r = await io.ask([0x55, 0x65, 0x01], (x) => x[0] === 0x55 && x[1] === 0x65 && x[3] === 0x02, WAIT_MS);
  return r ? reading(validPercent(r[2])) : [];
}

// Only a mouse that is awake answers, and it can take a few tries.
const A5_REQUEST = [0x00, 0x00, 0x00, 0x02, 0x02, 0x00, 0x83];
const A5_TRIES = 3;
const A5_WAIT_MS = 34;

async function readA5(io) {
  for (let attempt = 0; attempt < A5_TRIES; attempt++) {
    const r = await io.feature(A5_REQUEST, 0, A5_WAIT_MS);
    if (r[1] === 0xA1 && r[5] === 0x00 && r[6] === 0x83) return reading(validPercent(r[8]), r[7] > 0);
  }
  return [];
}

module.exports = [
  { label: 'MCHOSE G7', products: ids(0xA8A5, [0x2255]), page: 0xFF01, size: 65, read: readG7 },
  { label: 'MCHOSE X9', products: ids(0x3837, [0x6045]), page: 0xFF90, usage: 1, size: 64, read: readX9 },
  { label: 'MCHOSE A5 Pro Max', products: ids(0x2023, [0xF013, 0xF015, 0xF019]), page: 0xFFFF, feature: true, size: 65, read: readA5 },
];
