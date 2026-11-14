// How ffmpeg is told to open the microphone the speech input is bound to, and the words that
// say it in the logs and the mic test.

const { audioCache } = require('../audio/device-cache.js');
const { sttDevice } = require('./stt-device-state.js');

// Single source of truth for the STT/wake microphone input argv — the wake
// listener must always open the same device the STT recorder binds.
function _sttInputArgs() {
  // avfoundation addresses inputs as "<video>:<audio>"; the empty video half is
  // what keeps this an audio-only capture.
  if (sttDevice.avfIndex !== null) return ['-f', 'avfoundation', '-i', `:${sttDevice.avfIndex}`];
  if (sttDevice.linuxFormat) return ['-f', sttDevice.linuxFormat, '-i', 'default'];
  if (sttDevice.useWasapi) return ['-f', 'wasapi', '-i', 'default'];
  return sttDevice.dshowDevice ? ['-f', 'dshow', '-i', `audio=${sttDevice.dshowDevice}`] : null;
}
// How the mic is being captured, for the logs and the mic-test readout.
function _sttVia() {
  if (sttDevice.avfIndex !== null) return 'avfoundation';
  if (sttDevice.linuxFormat) return sttDevice.linuxFormat;
  return sttDevice.useWasapi ? 'wasapi' : 'dshow';
}
function _sttDeviceLabel() {
  if (sttDevice.avfIndex !== null) return audioCache.micLabel || `Input ${sttDevice.avfIndex}`;
  if (sttDevice.linuxFormat) return audioCache.micLabel || `Default (${sttDevice.linuxFormat})`;
  if (sttDevice.useWasapi) return audioCache.micLabel || 'Default (WASAPI)';
  return sttDevice.dshowDevice || 'unknown';
}

module.exports = { _sttInputArgs, _sttVia, _sttDeviceLabel };
