// Runs one audio command at a time: SoundVolumeView on Windows, the same request put in the
// words of the system elsewhere.

const { execFile } = require('node:child_process');
const { nativeCollectors } = require('../system/native-collectors.js');
const { SVV } = require('./svv-path.js');
const { audioReads } = require('./read-state.js');

// Promise wrapper around a single SoundVolumeView call, and the ONE place that
// knows SoundVolumeView is Windows-only: on Linux the same argv is translated to
// wpctl. Every SVV call site goes through here, so there is no execFile shadow
// and no platform check scattered through the audio code.
function svvExec(args) {
  const run = nativeCollectors
    ? Promise.resolve(nativeCollectors.audioCommand(args))
    : new Promise((resolve, reject) => execFile(SVV, args, e => (e ? reject(e) : resolve())));
  // Every audio change goes through here. A read already in flight began before
  // the change, and getAudioInfo() hands that same read to whoever asks next, so
  // a Deck mute key asking right after the press got the old state and waited
  // for the next 8s tick (issue #139). Once the change is done, the next read
  // starts fresh.
  return run.finally(() => { audioReads.pending = null; });
}

module.exports = { svvExec };
