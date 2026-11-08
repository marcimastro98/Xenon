'use strict';
// Mice on Compx chips (Pulsar, VXE, ATK, VGN, Kysona and others) share one 17-byte frame
// whose bytes add up to 0x55. It is what the Linux kernel's hid-pulsar driver reads.

const { ids, reading, validPercent } = require('./ids');

const REPORT = 0x08;
const FRAME_BYTES = 17;
const SUM = 0x55;
const COMMAND_STATUS = 0x03;
const COMMAND_BATTERY = 0x04;
const AT_VALUE = 6;
const WAIT_MS = 800;

function frame(command) {
  const bytes = Buffer.alloc(FRAME_BYTES);
  bytes[0] = REPORT;
  bytes[1] = command;
  bytes[FRAME_BYTES - 1] = (SUM - REPORT - command) & 0xFF;
  return bytes;
}

const sumsUp = (bytes) => bytes.subarray(0, FRAME_BYTES).reduce((sum, b) => (sum + b) & 0xFF, 0) === SUM;
const answers = (command) => (r) => r.length >= FRAME_BYTES && r[0] === REPORT && r[1] === command && sumsUp(r);

// Byte 7 means charging in some sources and "on the cable" in others: nobody can say
// which here, so the state stays unknown rather than wrong.
async function read(io) {
  const status = await io.ask(frame(COMMAND_STATUS), answers(COMMAND_STATUS), WAIT_MS);
  if (!status || status[AT_VALUE] !== 1) return [];
  const reply = await io.ask(frame(COMMAND_BATTERY), answers(COMMAND_BATTERY), WAIT_MS);
  return reply ? reading(validPercent(reply[AT_VALUE])) : [];
}

const products = [
  ...ids(0x3554, [0xF507, 0xF508, 0xF509, 0xF57C, 0xF57D, 0xF5D5, 0xF58E, 0xF58F, 0xF58A, 0xF58C, 0xF503, 0xF502, 0xFB3E, 0xFB3D, 0xF524, 0xF526, 0xF5F7, 0xF5F6]),
  ...ids(0x373B, [0x1085, 0x104D, 0x103F, 0x1040, 0x104C, 0x1031, 0x102E, 0x11D9, 0x11B6]),
  ...ids(0x3710, [0x5406, 0x3414]),
  ...ids(0x260D, [0x1175, 0x1193, 0x1154, 0x1196]),
];

module.exports = [{ label: 'Wireless mouse', products, page: 0xFF02, usage: 2, size: FRAME_BYTES, read }];
module.exports.frame = frame;
