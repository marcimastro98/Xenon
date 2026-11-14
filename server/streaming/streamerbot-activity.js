// Sends one Streamer.bot activity to the dashboards with its number.

const { broadcastSSE } = require('../http/sse-clients.js');
const { streamingLive } = require('./live.js');
const { SB_ACTIVITY_MAX } = require('./streamerbot-activity-limit.js');
const { sbActivity } = require('./streamerbot-activity-state.js');

function pushActivity(a) {
  if (!a || typeof a !== 'object') return;
  const item = Object.assign({ id: ++sbActivity.seq, at: Date.now() }, a);
  streamingLive.streamerbotActivity.push(item);
  if (streamingLive.streamerbotActivity.length > SB_ACTIVITY_MAX) streamingLive.streamerbotActivity = streamingLive.streamerbotActivity.slice(-SB_ACTIVITY_MAX);
  broadcastSSE('streamerbot_event', item);
}

module.exports = { pushActivity };
