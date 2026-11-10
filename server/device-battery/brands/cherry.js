'use strict';
// Cherry's wireless dongle answers on its FF1C collection, with no Cherry software running.

const { ids, reading, validPercent } = require('./ids');

const REQUEST = [0x04, 0x20, 0x00, 0x1A, 0x06];
const WAIT_MS = 500;

async function read(io) {
  const r = await io.ask(REQUEST, (x) => x[1] === 0x20 && x[8] > 0, WAIT_MS);
  return r ? reading(validPercent(r[8]), r[9] !== 0) : [];
}

module.exports = [{ label: 'Cherry wireless dongle', products: ids(0x046A, [0x01AC]), page: 0xFF1C, size: 64, read }];
