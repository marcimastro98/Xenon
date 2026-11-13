// Whether the game performance feed and the process list have anyone to show them to.

const LayersModel = require('../js/layers-model.js');
const { hub } = require('../settings/current.js');
const { sdkStreamGranted } = require('../widget-sdk/grants.js');
const { _feedWidgetInUse } = require('../grid/feed-widget-in-use.js');

function processesWanted() {
  return sdkStreamGranted('processes');
}

// The Game performance tile's feed: only while a game runs and a tile shows it.
function perfWanted() {
  if (_feedWidgetInUse('perf')) return true;
  // A tile on a hidden surface draws nothing, so it wants no feed.
  const layers = LayersModel.normalize(hub.settings && hub.settings.layers);
  if (layers.enabled && layers.widgets.some(w => w.kind === 'tile' && w.widget === 'perf' && !w.off && !layers.hidden.includes(w.surface))) return true;
  // A Store widget granted the `perf` stream (sdk-widgets.js), like `processes`.
  return sdkStreamGranted('perf');
}

module.exports = { processesWanted, perfWanted };
