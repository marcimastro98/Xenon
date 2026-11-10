'use strict';
// Akko S9 Ultra headset, as wireless-battery-tray (MIT) reads it. Its dongle is not one of
// the Rongyuan receivers of the Akko keyboards.

const { ids, reading, validPercent } = require('./ids');

const REQUEST = [0x02, 0x12, 0x01, ...new Array(59).fill(0), 0x71, 0x12];
const WAIT_MS = 500;

async function read(io) {
  const r = await io.ask(REQUEST, (x) => x.length >= 5 && x[1] === 0x12 && x[2] === 0x01 && x[4] > 0, WAIT_MS);
  return r ? reading(validPercent(r[4])) : [];
}

module.exports = [{ label: 'Akko S9 Ultra', products: ids(0x36EB, [0x1087]), page: 0x008C, usage: 1, size: 64, read }];
