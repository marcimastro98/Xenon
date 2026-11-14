// Mutes or unmutes the microphone.

const { audioCache } = require('./device-cache.js');
const { svvExec } = require('./svv-exec.js');

function setMicMute(mute) {
  const action = mute ? '/Mute' : '/Unmute';
  // Use the cached mic CLI ID (resolved from SoundVolumeView output) so the call works
  // regardless of the Windows display language. Falls back silently if the cache is empty.
  if (audioCache.micId) {
    svvExec([action, audioCache.micId]).catch(e => console.error(e.message));
  } else if (audioCache.speakerName) {
    // Last-resort: try the generic 'DefaultCaptureDevice' selector understood by SVV
    svvExec([action, 'DefaultCaptureDevice']).catch(e => console.error(e.message));
  }
}

module.exports = { setMicMute };
