// Lowers the speaker volume while Xenon speaks and puts it back afterwards.

const { audioCache } = require('./device-cache.js');
const { svvExec } = require('./svv-exec.js');

// Duck/restore helpers — lower device volume so music quiets while Xenon speaks,
// then restore to the saved level. Safe to call multiple times (guarded by flag).
function _duckSpeakerVolume() {
  if (!audioCache.ducked && audioCache.speakerId) {
    audioCache.volumeBeforeDuck = audioCache.speakerVolume;
    audioCache.ducked = true;
    svvExec(['/SetVolume', audioCache.speakerId, '30']).catch(() => {});
    process.stdout.write(`[Duck] volume ${audioCache.volumeBeforeDuck} → 30\n`);
  }
}
function _restoreSpeakerVolume() {
  if (audioCache.ducked && audioCache.speakerId) {
    const vol = audioCache.volumeBeforeDuck != null ? audioCache.volumeBeforeDuck : 70;
    audioCache.ducked = false;
    audioCache.volumeBeforeDuck = null;
    svvExec(['/SetVolume', audioCache.speakerId, String(vol)]).catch(() => {});
    process.stdout.write(`[Duck] restored → ${vol}\n`);
  }
}

module.exports = { _duckSpeakerVolume, _restoreSpeakerVolume };
