'use strict';
// JBL Quantum 910 reports its level only when it changes, so this only listens.

const { ids, reading, validPercent } = require('./ids');

const LEVEL_REPORT = 0x08;
const LISTEN_MS = 500;

async function read(io) {
  const r = await io.listen((x) => x[0] === LEVEL_REPORT && x.length >= 2, LISTEN_MS);
  return r ? reading(validPercent(r[1])) : [];
}

module.exports = [{ label: 'JBL Quantum 910', products: ids(0x0ECB, [0x2088]), page: 0xFF13, usage: 1, listenOnly: true, read }];
