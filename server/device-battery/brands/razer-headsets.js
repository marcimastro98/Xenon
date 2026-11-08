'use strict';
// Razer headsets on a dongle. The BlackShark frames are read from HaloBattery (MIT). Its
// remote mode frame, which Synapse sends first, is a write and stays out: a headset that
// will not answer without it gives no reading.

const { ids, reading, validPercent } = require('./ids');

const RAZER = 0x1532;

const BARRACUDA_COMMAND = 0x21;
const BARRACUDA_REQUEST = [0x01, 0x80, 0x08, 0x50, 0x41, 0x08, 0x08, 0x03, BARRACUDA_COMMAND];

async function readBarracuda(io) {
  const isAnswer = (r) => r[0] === 0x01 && r[1] === 0x80 && r[3] === 0x50 && r[4] === 0x49 && r[13] === BARRACUDA_COMMAND;
  const r = await io.ask(BARRACUDA_REQUEST, isAnswer);
  return r ? reading(validPercent(r[16])) : [];
}

const BLACKSHARK_REPORT = 0x02;
const BLACKSHARK_BATTERY = 0x21;
const BLACKSHARK_CHARGING = 0x2A;
const BLACKSHARK_ACK = 0x01;
const BLACKSHARK_TRIES = 3;
const BLACKSHARK_WAIT_MS = 150;
const AT_ECHO = 12;
const AT_DATA = 15;

const blackSharkFrame = (command) => [BLACKSHARK_REPORT, 0x80, 0x08, 0x00, 0x00, 0x50, 0x41, 0x08, 0x00, 0x03, command];

async function askBlackShark(io, command) {
  const isAnswer = (r) => r[0] === BLACKSHARK_REPORT && r[AT_ECHO] === command && r[AT_ECHO + 1] === BLACKSHARK_ACK;
  for (let attempt = 0; attempt < BLACKSHARK_TRIES; attempt++) {
    const reply = await io.ask(blackSharkFrame(command), isAnswer, BLACKSHARK_WAIT_MS);
    if (reply) return reply;
  }
  return null;
}

async function readBlackShark(io) {
  const reply = await askBlackShark(io, BLACKSHARK_BATTERY);
  const percent = reply ? validPercent(reply[AT_DATA]) : null;
  if (percent === null) return [];
  const state = await askBlackShark(io, BLACKSHARK_CHARGING);
  return [{ percent, charging: state ? state[AT_DATA] !== 0 : null }];
}

module.exports = [
  { label: 'Razer Barracuda Pro', products: ids(RAZER, [0x053A]), page: 0xFF00, size: 64, read: readBarracuda },
  { label: 'Razer BlackShark V2 Pro', products: ids(RAZER, [0x0555, 0x0556]), page: 0xFF00, size: 64, read: readBlackShark },
];
