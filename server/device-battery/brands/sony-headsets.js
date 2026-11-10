'use strict';
// Sony headsets push their level, so this only listens. The INZONE H5 and H9 are not here:
// where their payload starts was never checked.

const { ids, reading, validPercent } = require('./ids');

const SONY = 0x054C;
const LISTEN_MS = 500;

// Charging replaces the level with 0x80, which is no reading.
const PULSE_REPORT = 0xB0;
const PULSE_BYTES = 8;
const PULSE_CONNECTED = 0x08;

async function readPulse(io) {
  const r = await io.listen((x) => x[0] === PULSE_REPORT && x.length >= PULSE_BYTES, LISTEN_MS);
  return r && r[4] & PULSE_CONNECTED ? reading(validPercent(r[3]), false) : [];
}

const BUDS_BYTES = 20;
const AT_RIGHT = 14;
const AT_LEFT = 16;
const AT_SUM = 19;
const BUDS_SUM_BASE = 117;

const isBudsStatus = (r) => r.length >= BUDS_BYTES && r[0] === 0x02 && r[1] === 0x12 && r[2] === 0x04
  && r[AT_SUM] === ((r[AT_RIGHT] + r[AT_LEFT] + BUDS_SUM_BASE) & 0xFF);

async function readBuds(io) {
  const r = await io.listen(isBudsStatus, LISTEN_MS);
  return r ? reading(validPercent(Math.min(r[AT_LEFT], r[AT_RIGHT]))) : [];
}

module.exports = [
  { label: 'Sony PULSE 3D', products: ids(SONY, [0x0D5E]), page: 0xFF01, usage: 0x0020, listenOnly: true, read: readPulse },
  { label: 'Sony INZONE Buds', products: ids(SONY, [0x0EC2]), listenOnly: true, read: readBuds },
];
