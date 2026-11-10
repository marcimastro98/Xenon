'use strict';
// Redragon M910-KS on a Sinowealth dongle, as redragon-m910ks (MIT) reads it. The wired id
// is left out: the charge is the dongle's to tell. 0x75 on this chip is firmware mode.

const { ids, reading, validPercent } = require('./ids');

const REPORT = 0x05;
const BATTERY = 0x90;
const WAIT_MS = 90;

async function read(io) {
  const r = await io.feature([REPORT, BATTERY, 0x00, 0x00, 0x00, 0x00], REPORT, WAIT_MS);
  return r[0] === REPORT && r[1] === BATTERY ? reading(validPercent(r[3])) : [];
}

module.exports = [{ label: 'Redragon M910-KS', products: ids(0x258A, [0x002F]), page: 0xFF00, feature: true, size: 8, read }];
