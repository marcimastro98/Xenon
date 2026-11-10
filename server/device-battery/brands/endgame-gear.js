'use strict';
// Endgame Gear OP1w. Its reply has no echo of the command, only the report id and a status
// byte, so this asks one thing and takes the answer only when the status says ready.

const { ids, reading, validPercent } = require('./ids');

const REPORT = 0xA1;
const BATTERY = 0xB4;
const READY = 1;
const BUSY = 3;
const AT_LEVEL = 16;
const TRIES = 3;
const SETTLE_MS = 350;
const RETRY_MS = 200;

async function read(io) {
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const r = await io.feature([REPORT, BATTERY], REPORT, SETTLE_MS + attempt * RETRY_MS);
    if (r[0] !== REPORT) return [];
    if (r[1] === READY) return reading(validPercent(r[AT_LEVEL]));
    if (r[1] !== BUSY) return [];
  }
  return [];
}

module.exports = [{ label: 'Endgame Gear OP1w', products: ids(0x3367, [0x1970, 0x1984]), page: 0xFF01, usage: 2, feature: true, size: 64, read }];
