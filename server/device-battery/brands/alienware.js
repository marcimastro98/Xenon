'use strict';
// Alienware AW620M, as aw620m-macos (MIT) reads it. A dongle with no mouse linked answers
// with a failed status in byte 5.

const { ids, reading, validPercent } = require('./ids');

const REQUEST = [0x00, 0xC0, 0x0A, 0x00, 0x00, 0x00, 0x00];
const STATUS_FAILED = 0xFA;
const CHARGING_STATES = new Set([1, 2, 3]);
const WAIT_MS = 500;

async function read(io) {
  const r = await io.ask(REQUEST, (x) => x[0] === 0xC0 && x[1] === 0x0A, WAIT_MS);
  return r && r[5] !== STATUS_FAILED ? reading(validPercent(r[10]), CHARGING_STATES.has(r[11])) : [];
}

module.exports = [{ label: 'Alienware AW620M', products: ids(0x413C, [0x302D, 0x302E]), page: 0xFF00, usage: 1, size: 65, read }];
