// The engine's one notice per game that exclusive full screen hides the widgets over it.

const fpsMonitor = require('../fps-monitor.js');
const { createExclusiveHint } = require('../exclusive-hint.js');
const { broadcastSSE } = require('../http/sse-clients.js');
const LayersModel = require('../js/layers-model.js');
const { hub } = require('../settings/current.js');

// A game in exclusive full screen hides the widgets over it: said once per game
// (exclusive-hint.js), only when there is something on the overlay to hide.
const _exclusiveHint = createExclusiveHint({
  fps: fpsMonitor,
  overlayShown: () => {
    const layers = LayersModel.normalize(hub.settings && hub.settings.layers);
    return LayersModel.surfaceKeys(layers).some((k) => k.startsWith('overlay:')
      && LayersModel.shownFor(layers, k).some((w) => w.show !== 'notGaming'));
  },
  broadcast: (payload) => broadcastSSE('exclusive_hint', payload),
});

module.exports = { _exclusiveHint };
