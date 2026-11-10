'use strict';
// PlayStation controllers put their battery in the input they already send, so this
// only listens. Never read their feature reports over Bluetooth: that read switches the
// controller's report mode, and games using DirectInput stop seeing it until it is
// turned off. In the short Bluetooth mode nothing here matches and there is no reading.

const { ids } = require('./ids');

const SONY = 0x054C;
const LISTEN_MS = 500;
const LOW_NIBBLE = 0x0F;
const CABLE_BIT = 0x10;
const FULL_STEP = 10;
const STEP_PERCENT = 10;
const HALF_STEP = 5;
const USB_REPORT_BYTES = 64;

const DUALSENSE = { usbReport: 0x01, usbStatus: 53, btReport: 0x31, btStatus: 54 };
const DUALSHOCK = { usbReport: 0x01, usbStatus: 30, btReport: 0x11, btStatus: 32 };

const stepPercent = (step) => (step < FULL_STEP ? step * STEP_PERCENT + HALF_STEP : 100);

function decodeDualSense(status) {
  const state = status >> 4;
  const step = status & LOW_NIBBLE;
  if (state === 0 || state === 1) return [{ percent: stepPercent(step), charging: state === 1 }];
  return state === 2 ? [{ percent: 100, charging: false }] : [];
}

function decodeDualShock(status) {
  const step = status & LOW_NIBBLE;
  if ((status & CABLE_BIT) === 0) return [{ percent: stepPercent(step), charging: false }];
  return [{ percent: stepPercent(step), charging: step <= FULL_STEP }];
}

function listener(layout, decode) {
  const statusOf = (r) => {
    if (r[0] === layout.btReport) return r[layout.btStatus];
    return r[0] === layout.usbReport && r.length >= USB_REPORT_BYTES ? r[layout.usbStatus] : undefined;
  };
  return async (io) => {
    const report = await io.listen((r) => statusOf(r) !== undefined, LISTEN_MS);
    return report ? decode(statusOf(report)) : [];
  };
}

module.exports = [
  { label: 'DualSense', products: ids(SONY, [0x0CE6, 0x0DF2]), page: 1, usage: 5, listenOnly: true, read: listener(DUALSENSE, decodeDualSense) },
  { label: 'DualShock 4', products: ids(SONY, [0x05C4, 0x09CC, 0x0BA0]), page: 1, usage: 5, listenOnly: true, read: listener(DUALSHOCK, decodeDualShock) },
];
