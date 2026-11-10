'use strict';
// Attack Shark mice push their level, so this only listens. Status layout as in
// mouse-battery-tray (MIT) and attack-shark-x11-battery (MIT).

const { ids, reading, validPercent } = require('./ids');

const REPORT = 0x03;
const MARK = 0x40;
const X6 = 0x85;              // counts 1 to 10 where the others count percent
const X6_STEP_PERCENT = 10;
const MICE = new Set([0x55, 0x10, X6, 0x4D, 0xBE, 0x07]);
const DISCHARGING = 0x01;
const DOCKED = new Set([0x02, 0x03, 0x80]);
const STATUS_BYTES = 5;
const LISTEN_MS = 500;

const isStatus = (r) => r.length >= STATUS_BYTES && r[0] === REPORT && MICE.has(r[1]) && r[2] === MARK
  && (r[3] === DISCHARGING || DOCKED.has(r[3]));

async function read(io) {
  const r = await io.listen(isStatus, LISTEN_MS);
  if (!r) return [];
  return reading(validPercent(r[1] === X6 ? r[4] * X6_STEP_PERCENT : r[4]), DOCKED.has(r[3]));
}

module.exports = [{
  label: 'Attack Shark mouse', products: ids(0x1D57, [0xFA60, 0xFA55, 0xFA61, 0xFA50, 0xFA62, 0xFA56]), usbInterface: 2, listenOnly: true, read,
}];
