'use strict';
// Game controllers that put their battery in reports they already send, so this only
// listens. Layouts as in HaloBattery (MIT). Nothing here may be sent: a feature report 06
// switches an 8BitDo's report mode, and 80 02 changes the USB state of a Switch pad.

const { ids, percentOfSteps, reading, validPercent } = require('./ids');

// The puck reports about every 2.5 s while a controller is awake.
const STEAM_REPORT = 0x43;
const STEAM_BYTES = 15;
const STEAM_CHARGING = 2;
const STEAM_STATES = new Set([1, STEAM_CHARGING, 4]);
const STEAM_LISTEN_MS = 3000;

async function readSteam(io) {
  const isStatus = (r) => r[0] === STEAM_REPORT && r.length >= STEAM_BYTES && STEAM_STATES.has(r[1]);
  const r = await io.listen(isStatus, STEAM_LISTEN_MS);
  return r ? reading(validPercent(r[2]), r[1] === STEAM_CHARGING) : [];
}

// A 0 there is padding, not a level, so the listening goes on past it.
const EIGHTBITDO_REPORT = 0x04;
const AT_EIGHTBITDO_STATUS = 14;
const LEVEL_BITS = 0x7F;
const EIGHTBITDO_CHARGING = 0x80;
const EIGHTBITDO_LISTEN_MS = 400;

async function read8BitDo(io) {
  const isStatus = (r) => r[0] === EIGHTBITDO_REPORT && (r[AT_EIGHTBITDO_STATUS] & LEVEL_BITS) > 0;
  const r = await io.listen(isStatus, EIGHTBITDO_LISTEN_MS);
  if (!r) return [];
  const status = r[AT_EIGHTBITDO_STATUS];
  return reading(validPercent(status & LEVEL_BITS), (status & EIGHTBITDO_CHARGING) !== 0);
}

// Heard only in the full report modes: a pad in its simple Bluetooth mode has no level.
const SWITCH_REPORTS = new Set([0x21, 0x30, 0x31]);
const SWITCH_STEPS = 4;
const SWITCH_CHARGING = 0x10;
const SWITCH_LISTEN_MS = 500;

async function readSwitch(io) {
  const r = await io.listen((x) => SWITCH_REPORTS.has(x[0]) && x.length >= 3, SWITCH_LISTEN_MS);
  return r ? reading(validPercent(percentOfSteps(r[2] >> 5, SWITCH_STEPS)), (r[2] & SWITCH_CHARGING) !== 0) : [];
}

module.exports = [
  { label: 'Steam Controller', products: ids(0x28DE, [0x1304, 0x1305]), page: 0xFF00, usage: 1, listenOnly: true, read: readSteam },
  { label: '8BitDo Pro 3', products: ids(0x2DC8, [0x6009]), page: 1, listenOnly: true, read: read8BitDo },
  { label: 'Nintendo Switch controller', products: ids(0x057E, [0x2009, 0x2006, 0x2007]), page: 1, listenOnly: true, read: readSwitch },
];
