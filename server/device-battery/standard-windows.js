'use strict';
// The one route that needs no brand: a device that declares the standard Battery Strength
// usage in a feature report, the same usage Linux reads for any brand. Windows lets a
// handle opened without read or write access read a feature report, so a mouse or
// keyboard collection the system keeps for itself can still answer.

const { boundedCall: call } = require('../hid/bounded-call');

const USAGE_PAGE_DEVICE_CONTROLS = 0x06;
const USAGE_BATTERY_STRENGTH = 0x20;
const HIDP_FEATURE = 2;
const HIDP_STATUS_SUCCESS = 0x00110000;
const FILE_SHARE_READ_WRITE = 0x03;
const OPEN_EXISTING = 3;
const INVALID_HANDLE = -1;
const VALUE_CAPS_BYTES = 72;
const CAPS_REPORT_ID = 2;
const CAPS_LOGICAL_MIN = 40;
const CAPS_LOGICAL_MAX = 44;
// Bluetooth LE keyboards and mice: Windows reports those itself, through battery.ps1.
const BLUETOOTH_LE_HID = '{00001812-';

let api = null;

function load() {
  if (api) return api;
  const koffi = require('koffi');
  const hid = koffi.load('hid.dll');
  const kernel32 = koffi.load('kernel32.dll');
  api = {
    createFile: kernel32.func('intptr __stdcall CreateFileW(str16, uint32, uint32, void *, uint32, uint32, void *)'),
    closeHandle: kernel32.func('int __stdcall CloseHandle(intptr)'),
    getPreparsed: hid.func('int __stdcall HidD_GetPreparsedData(intptr, _Out_ void **)'),
    freePreparsed: hid.func('int __stdcall HidD_FreePreparsedData(void *)'),
    getFeature: hid.func('int __stdcall HidD_GetFeature(intptr, _Inout_ uint8_t *, uint32)'),
    valueCaps: hid.func('uint32 __stdcall HidP_GetSpecificValueCaps(int, uint16, uint16, uint16, _Out_ uint8_t *, _Inout_ uint16 *, void *)'),
    usageValue: hid.func('uint32 __stdcall HidP_GetUsageValue(int, uint16, uint16, uint16, _Out_ uint32 *, void *, uint8_t *, uint32)'),
  };
  return api;
}

// Logical limits are the device's own scale. A device that leaves them out means percent.
function scaleUsage(raw, min, max) {
  if (min < max) return raw >= min && raw <= max ? Math.round(((raw - min) * 100) / (max - min)) : null;
  return raw >= 0 && raw <= 100 ? raw : null;
}

async function batteryCaps(a, preparsed) {
  const caps = Buffer.alloc(VALUE_CAPS_BYTES);
  const count = [1];
  const status = await call(a.valueCaps, HIDP_FEATURE, USAGE_PAGE_DEVICE_CONTROLS, 0, USAGE_BATTERY_STRENGTH, caps, count, preparsed);
  if (status !== HIDP_STATUS_SUCCESS || !count[0]) return null;
  return { reportId: caps[CAPS_REPORT_ID], min: caps.readInt32LE(CAPS_LOGICAL_MIN), max: caps.readInt32LE(CAPS_LOGICAL_MAX) };
}

async function readValue(a, handle, preparsed, info, caps) {
  const report = Buffer.alloc(info.featureLength);
  report[0] = caps.reportId;
  if (!(await call(a.getFeature, handle, report, report.length))) return null;
  const value = [0];
  const status = await call(a.usageValue, HIDP_FEATURE, USAGE_PAGE_DEVICE_CONTROLS, 0, USAGE_BATTERY_STRENGTH, value, preparsed, report, report.length);
  return status === HIDP_STATUS_SUCCESS ? scaleUsage(value[0], caps.min, caps.max) : null;
}

async function readCollection(a, info, guard) {
  guard.enter(info);
  const handle = await call(a.createFile, info.path, 0, FILE_SHARE_READ_WRITE, null, OPEN_EXISTING, 0, null);
  if (handle === INVALID_HANDLE) return null;
  const preparsed = [null];
  try {
    if (!(await call(a.getPreparsed, handle, preparsed))) return null;
    const caps = await batteryCaps(a, preparsed[0]);
    return caps ? await readValue(a, handle, preparsed[0], info, caps) : null;
  } finally {
    if (preparsed[0]) await call(a.freePreparsed, preparsed[0]).catch(() => {});
    await call(a.closeHandle, handle).catch(() => {});
    guard.leave();
  }
}

// known(info): a device a brand protocol already reads, so it is not listed twice.
async function readStandard(hid, known, guard) {
  const a = load();
  const devices = new Map();
  for (const info of await hid.listAll()) {
    if (!info.featureLength || !info.product || known(info) || info.path.toLowerCase().includes(BLUETOOTH_LE_HID)) continue;
    const percent = await readCollection(a, info, guard).catch(() => null);
    if (percent !== null) devices.set(info.product, { name: info.product, percent, charging: null, source: 'dongle' });
  }
  return [...devices.values()];
}

module.exports = { readStandard, scaleUsage };
