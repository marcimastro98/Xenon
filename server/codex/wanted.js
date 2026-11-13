// Whether anything shows Codex right now: a dashboard is open and a Codex or ChatGPT tile, or a
// widget given the stream, is there.

const { sseClients } = require('../http/sse-clients.js');
const { _sdkStreamGranted } = require('../widget-sdk/grants.js');
const { _widgetPlaced } = require('../grid/widget-placed.js');

function _codexWanted() {
  return sseClients.size > 0 && (_widgetPlaced('openaicodex') || _widgetPlaced('chatgpt') || _sdkStreamGranted('codex'));
}

module.exports = { _codexWanted };
