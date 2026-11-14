// Tells the widgets once why the sound levels cannot be read.

const { sseClients, broadcastSSE } = require('../http/sse-clients.js');
const audioLevels = require('../audio-levels.js');
const { audioReads } = require('./read-state.js');
const { audioLevelsWanted } = require('./levels-wanted.js');

function announceAudioLevelsProblem() {
  const problem = audioLevelsWanted() ? audioLevels.failure() : '';
  if (problem === audioReads.levelsProblemSaid) return;
  audioReads.levelsProblemSaid = problem;
  if (problem && sseClients.size > 0) {
    broadcastSSE('audiolevels', { peaks: {}, problem, minVersion: audioLevels.minVersion() });
  }
}

module.exports = { announceAudioLevelsProblem };
