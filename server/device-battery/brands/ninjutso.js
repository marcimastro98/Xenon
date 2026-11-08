'use strict';
// Ninjutso Sora V2, as ninjutso-sora-v2-battery-tray (MIT) reads it. The dongle keeps its
// last value when the mouse is gone, so only a mouse it calls online counts.

const { ids, reading, validPercent } = require('./ids');

const NORDIC = 0x1915;
const REPORT = 0x05;
const COMMAND = 0x15;
const REQUEST = [REPORT, COMMAND, 0x00, 0x00, 0x01, 0x00, 0x00, 0x04];
const REPORT_BYTES = 32;
const REPLY_BYTES = 13;
const TRIES = 3;
const NAME = /sora|ninjutso/i;   // 0x1915 is Nordic's id, on anyone's product
const WAIT_MS = 30;

function reader(needsOnline) {
  return async (io) => {
    for (let attempt = 0; attempt < TRIES; attempt++) {
      const r = await io.feature(REQUEST, REPORT, WAIT_MS);
      if (r.length < REPLY_BYTES || r[1] !== COMMAND || !r[9]) continue;
      return needsOnline && r[12] !== 1 ? [] : reading(validPercent(r[9]), r[10] === 1);
    }
    return [];
  };
}

const model = (productId, needsOnline) => ({
  label: 'Ninjutso Sora V2', products: ids(NORDIC, [productId]), page: 0xFFA0, named: NAME, feature: true, size: REPORT_BYTES, read: reader(needsOnline),
});

module.exports = [model(0xAE1C, true), model(0xAE12, false)];
