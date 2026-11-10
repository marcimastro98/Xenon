'use strict';
// SteelSeries headsets and mice. Facts from the Linux kernel, HeadsetControl and rivalcfg.

const { ids, percentOfSteps, reading, validPercent } = require('./ids');

const STEELSERIES = 0x1038;
const STATUS_REPLY = 0xB0;
const TOP_STEP = 4;

// A reply that repeats the two bytes of the request.
function echoed(request, decode) {
  return async (io) => {
    const reply = await io.ask(request, (r) => r[0] === request[0] && r[1] === request[1]);
    return reply ? decode(reply) : [];
  };
}

const statusFrame = (decode) => async (io) => {
  const reply = await io.ask([0x00, STATUS_REPLY], (r) => r[0] === STATUS_REPLY);
  return reply ? decode(reply) : [];
};

const OFFLINE_ARCTIS = 0x01;
const OFFLINE_NOVA = 0x02;
const decodeArctisPlus = (r) => (r[1] === OFFLINE_ARCTIS || r[2] === 0 || r[2] > TOP_STEP ? [] : reading(percentOfSteps(r[2], TOP_STEP), r[3] === 1));
const decodeNovaLight = (r) => (r[1] === OFFLINE_NOVA ? [] : reading(validPercent(r[3]), r[4] === 1));
// Sources disagree on byte 3 of the Nova 7 and agree on the level in byte 2.
const decodeNova7Steps = (r) => (r[2] > 0 && r[2] <= TOP_STEP ? reading(percentOfSteps(r[2], TOP_STEP)) : []);
const decodeNova7Percent = (r) => reading(validPercent(r[2]));

const NOVA_PRO_BYTES = 31;
const NOVA_PRO_STEPS = 8;
const NOVA_PRO_STATE = 15;
const NOVA_PRO_OFFLINE = 0x01;
const NOVA_PRO_CABLE = 0x02;

function decodeNovaPro(r) {
  if (r.length <= NOVA_PRO_STATE || r[NOVA_PRO_STATE] === NOVA_PRO_OFFLINE) return [];
  if (r[6] === 0 || r[6] > NOVA_PRO_STEPS) return [];
  return reading(percentOfSteps(r[6], NOVA_PRO_STEPS), r[NOVA_PRO_STATE] === NOVA_PRO_CABLE);
}

const headset = (label, productIds, read, size, page, usage) => ({ label, products: ids(STEELSERIES, productIds), read, size, page, usage });

// The mice answer on a fixed USB interface and name no collection of their own.
const MOUSE_WIRED = 0x92;
const MOUSE_WIRELESS = 0xD2;
const MOUSE_REPLY_MS = 200;
const MOUSE_STEP_PERCENT = 5;
const MOUSE_BYTES = 64;
const CHARGING_BIT = 0x80;
const LEVEL_BITS = 0x7F;

function aeroxReader(command) {
  return async (io) => {
    const reply = await io.ask([0x00, command], (r) => r.length >= 2, MOUSE_REPLY_MS);
    if (!reply) return [];
    return reading(validPercent(((reply[1] & LEVEL_BITS) - 1) * MOUSE_STEP_PERCENT), (reply[1] & CHARGING_BIT) !== 0);
  };
}

const RIVAL_REQUEST = [0x00, 0xAA, 0x01];

async function readRival(io) {
  const reply = await io.ask(RIVAL_REQUEST, (r) => r.length >= 3, MOUSE_REPLY_MS);
  return reply ? reading(validPercent(reply[0]), reply[2] !== 0) : [];
}

const mouse = (label, productIds, read, usbInterface = 3) => ({ label, products: ids(STEELSERIES, productIds), usbInterface, size: MOUSE_BYTES, read });

module.exports = [
  headset('SteelSeries Arctis', [0x12B3, 0x12B6, 0x12D7, 0x12D5], echoed([0x06, 0x12], (r) => (r[2] === 1 ? [] : reading(validPercent(r[3])))), 31, 0xFF43, 0x0202),
  headset('SteelSeries Arctis 7', [0x1260, 0x12AD, 0x1252, 0x1280], echoed([0x06, 0x18], (r) => reading(validPercent(r[2]))), 31, 0xFF43, 0x0202),
  headset('SteelSeries Arctis 7+', [0x220E, 0x2212, 0x2216, 0x2236], statusFrame(decodeArctisPlus), 64, 0xFFC0, 1),
  headset('SteelSeries Arctis Nova', [0x2269, 0x226D, 0x2232, 0x2253], statusFrame(decodeNovaLight), 64, 0xFFC0, 1),
  headset('SteelSeries Arctis Nova 7', [0x2202, 0x2206, 0x220A, 0x223A, 0x227A, 0x22A4], statusFrame(decodeNova7Steps), 64, 0xFFC0, 1),
  headset('SteelSeries Arctis Nova 7', [0x22A1, 0x227E, 0x2258, 0x229E, 0x22AD, 0x22A9, 0x22A5, 0x22A7, 0x2298], statusFrame(decodeNova7Percent), 64, 0xFFC0, 1),
  headset('SteelSeries Arctis Nova Pro', [0x12E0, 0x12E5], echoed([0x06, STATUS_REPLY], decodeNovaPro), NOVA_PRO_BYTES),
  mouse('SteelSeries Aerox', [0x183A, 0x187A, 0x1854, 0x185E, 0x1862, 0x185A, 0x1876, 0x1842, 0x184A], aeroxReader(MOUSE_WIRED)),
  mouse('SteelSeries Aerox', [0x1838, 0x1878, 0x1852, 0x185C, 0x1860, 0x1858, 0x1874, 0x1840, 0x1848], aeroxReader(MOUSE_WIRELESS)),
  mouse('SteelSeries Rival 3', [0x1830, 0x1872], readRival),
  mouse('SteelSeries Rival 650', [0x172B, 0x1726], readRival, 0),
];
