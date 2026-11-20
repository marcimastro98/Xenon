'use strict';
// Whether the PC's screens are off, as the Windows app tells it, and whether the
// hardware reads wait for that.
//
// A 5.x report: an RTX 4090 whose display driver failed as the screens woke from
// sleep (a two-minute freeze), and never on the nights nothing read the GPU. Xenon
// reads it too (gpu.ps1: nvidia-smi, NVAPI, LibreHardwareMonitor). Nobody sees a
// sensor while the screens sleep, so the reads wait then, and a while after the
// screens are back, while the driver brings them up.
//
// The Windows app tells the kiosk page (screens_win32.rs, `ambientFreeze('screens-off')`),
// the page tells the server (POST /screens-off, ambient-freeze.js), and tells it
// again on every stream open, so an app that restarted never leaves the reads stopped.
// A paired device watching keeps them going: its screen is not one of the PC's.

const WAKE_QUIET_MS = 15000;

let off = false;
let onAt = 0;

/** @param {boolean} next @param {number} [now] */
function setScreensOff(next, now = Date.now()) {
  if (next === off) return;
  off = next;
  if (!next) onAt = now;
}

/** True while the screens are off, or came back less than WAKE_QUIET_MS ago. */
function quiet(now = Date.now()) {
  return off || (onAt > 0 && now - onAt < WAKE_QUIET_MS);
}

/**
 * Whether the sensor reads skip this turn: the screens are quiet and no paired
 * device has a stream open (openSseClient marks those with `_xenonDevice`).
 * @param {Iterable<any>} clients the open SSE responses
 */
function readsWait(clients, now = Date.now()) {
  if (!quiet(now)) return false;
  for (const c of clients) if (c?._xenonDevice) return false;
  return true;
}

function reset() { off = false; onAt = 0; }

module.exports = { setScreensOff, quiet, readsWait, reset, WAKE_QUIET_MS };
