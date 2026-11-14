// Starts the search for the microphone once, and binds it again when the input device changes.

const wakeWord = require('../wakeword.js');
const { audioCache } = require('../audio/device-cache.js');
const { sttDevice } = require('./stt-device-state.js');
const { _sttDeviceWaiters, _sttPending } = require('./stt-pending.js');
const { _initSttDevice } = require('./stt-devices.js');
const { sttStart } = require('./stt-start-state.js');

function _startSttDevice() {
  if (sttStart.started) return;
  sttStart.started = true;
  _initSttDevice();
}

function _sttDeviceWhenReady() {
  _startSttDevice();
  return new Promise(resolve => {
    if (sttDevice.ready) resolve();
    else _sttDeviceWaiters.push(resolve);
  });
}

function _maybeRebindSttDevice() {
  if (!sttDevice.ready || sttDevice.useWasapi) return;          // wasapi follows "default" already
  if (!audioCache.micLabel || audioCache.micLabel === sttDevice.micLabel) return;
  if (sttStart.rebindTimer) return;
  sttStart.rebindTimer = setTimeout(async () => {
    sttStart.rebindTimer = null;
    if (_sttPending.size > 0) { _maybeRebindSttDevice(); return; } // try again after the current capture
    if (!audioCache.micLabel || audioCache.micLabel === sttDevice.micLabel) return;
    process.stdout.write(`[STT] Default mic changed to "${audioCache.micLabel}": rebinding capture device\n`);
    try {
      await _initSttDevice();
      // The wake listener pins the device at spawn time — bounce it so it
      // re-reads the rebound input args instead of listening to the old mic.
      wakeWord.bounce();
    } catch (e) { process.stdout.write('[STT] Rebind error: ' + e.message + '\n'); }
  }, 800);
}

module.exports = { _startSttDevice, _sttDeviceWhenReady, _maybeRebindSttDevice };
