'use strict';
// Keychron mice through the Ultra-Link 8K receiver, as perigauge (MIT) reads them. A
// sleeping mouse stays silent. The M5's own id is only known with a feature frame answered
// on the interrupt pipe, which `io` cannot do, so it is not here.

const { ids, reading, validPercent } = require('./ids');

const STATUS = 0x05;
const REQUEST = [0xB3, STATUS];
const REPLIES = new Set([0xB6, 0xB4]);
const AT_LEVEL = 20;
const TRIES = 3;
const WAIT_MS = 450;

const isStatus = (r) => REPLIES.has(r[0]) && r[1] === STATUS && r.length > AT_LEVEL;

async function read(io) {
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const reply = await io.ask(REQUEST, isStatus, WAIT_MS);
    if (reply) return reading(validPercent(reply[AT_LEVEL]));
  }
  return [];
}

module.exports = [{ label: 'Keychron wireless mouse', products: ids(0x3434, [0xD028]), page: 0xFFC1, size: 64, read }];
