'use strict';
// Xbox controllers on Windows, wireless or on the adapter, through the system's own XInput.
// It gives four levels, not a percent, so the number shown is the middle of each level.

const { boundedCall: call } = require('../hid/bounded-call');

const MAX_PADS = 4;
const DEVTYPE_GAMEPAD = 0;
const ERROR_SUCCESS = 0;
const BATTERY_TYPE_ALKALINE = 2;
const BATTERY_TYPE_NIMH = 3;
const LEVEL_PERCENT = [5, 33, 66, 100];   // empty, low, medium, full
const NAME = 'Xbox controller';
const GUARD_KEY = 'xinput';

let getBattery = null;

function load() {
  if (getBattery) return getBattery;
  const koffi = require('koffi');
  koffi.struct('XXINPUT_BATTERY', { BatteryType: 'uint8', BatteryLevel: 'uint8' });
  getBattery = koffi.load('xinput1_4.dll').func('uint32 __stdcall XInputGetBatteryInformation(uint32, uint8, _Out_ XXINPUT_BATTERY *)');
  return getBattery;
}

// A wired pad and an empty slot both have no battery to report.
function decode(info) {
  if (info.BatteryType !== BATTERY_TYPE_ALKALINE && info.BatteryType !== BATTERY_TYPE_NIMH) return null;
  return LEVEL_PERCENT[info.BatteryLevel] ?? null;
}

async function readGamepads(guard) {
  guard.enter(GUARD_KEY);
  const get = load();
  const devices = [];
  for (let pad = 0; pad < MAX_PADS; pad++) {
    const info = {};
    if ((await call(get, pad, DEVTYPE_GAMEPAD, info)) !== ERROR_SUCCESS) continue;
    const percent = decode(info);
    if (percent === null) continue;
    devices.push({ name: devices.length ? `${NAME} ${devices.length + 1}` : NAME, percent, charging: null, source: 'dongle' });
  }
  guard.leave();
  return devices;
}

module.exports = { readGamepads, decode };
