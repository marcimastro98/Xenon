'use strict';
// The PC going down or to sleep and coming back: the lights handed to their own hardware, then
// taken again.

const native = require('../lighting-native/index.js');
const { bridge } = require('./bridge-state.js');
const { wokenBoards } = require('./sdk-call.js');
const { releaseAll } = require('./sdk-write.js');
const { wakeVendorBoard } = require('./session.js');
const { syncAnimationTicker } = require('./upkeep.js');
const { apply } = require('./paint.js');

const POWER_HOLD_MS = 60000;                     // painting resumes by itself if the PC did not go off after all (a cancelled shutdown)

// The PC is about to shut down, restart, sign out or sleep. Hand every light
// back to its own hardware while this process still runs: a controller left in
// Xenon's direct mode keeps its last frame on standby power, lit (and flickering)
// with the PC off. Nothing is painted again until powerUp(), which the wake from
// sleep calls, or POWER_HOLD_MS later when a shutdown was cancelled.
async function powerDown() {
  bridge.poweredDown = true;
  syncAnimationTicker();
  clearTimeout(bridge.powerHoldTimer);
  bridge.powerHoldTimer = setTimeout(powerUp, POWER_HOLD_MS);
  if (bridge.powerHoldTimer.unref) bridge.powerHoldTimer.unref();
  try { await native.powerDown(); } catch (e) { bridge.lastError = e.message; }
  await releaseAll({ keepNative: true });
}

function powerUp() {
  clearTimeout(bridge.powerHoldTimer);
  bridge.powerHoldTimer = null;
  if (!bridge.poweredDown) return;
  bridge.poweredDown = false;
  native.resume();
  wokenBoards.clear();
  wakeVendorBoard();
  bridge.lastWrite.clear();
  apply();
}

module.exports = { POWER_HOLD_MS, powerDown, powerUp };
