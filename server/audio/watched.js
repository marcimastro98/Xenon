// Notes that a dashboard asked for the sound levels, and says whether they are worth reading
// often.

const { sdkStreamGranted } = require('../widget-sdk/grants.js');
const { AUDIO_WATCH_WINDOW_MS } = require('./poll-timings.js');
const { audioWatched } = require('./watched-state.js');

function _noteAudioWatched() { audioWatched.at = Date.now(); }
function audioPollWanted() {
  if (sdkStreamGranted('audio')) return true;
  return Date.now() - audioWatched.at < AUDIO_WATCH_WINDOW_MS;
}

module.exports = { _noteAudioWatched, audioPollWanted };
