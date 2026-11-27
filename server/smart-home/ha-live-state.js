// What Home Assistant says while a dashboard watches it: the state of the chosen devices and of
// the Deck keys bound to them, sent on to the open dashboards a few times a second at most.

const { broadcastSSE } = require('../http/sse-clients.js');
const { readHubSettings } = require('../settings/read.js');
const { deckHa } = require('./deck-clients.js');
const { haWatch } = require('./ha-watch-state.js');
const { _haDeckWatchClients, haDeckWatchUnion } = require('./deck-watch.js');
const doorbell = require('./doorbell.js');
const homeLog = require('./home-events.js');

// Compact { id: { state, brightness? } } map for the deck-bound entities.
function buildHaDeckStates() {
  const states = {};
  for (const ent of deckHa.snapshot(haDeckWatchUnion())) {
    const item = { state: ent.state };
    if (typeof ent.brightness === 'number') item.brightness = ent.brightness;
    states[ent.id] = item;
  }
  return { states };
}

// Build the payload for the selected entities (from settings) plus connection flag.
// `energy` carries the Energy widget's own selection (power/energy sensors) so
// the two surfaces share one SSE event without sharing one entity list.
async function buildHaState() {
  const s = (await readHubSettings().catch(() => null)) || {};
  const ha = (s && s.homeAssistant) || {};
  const configured = !!(ha.url && ha.token);
  return {
    configured,
    connected: configured && deckHa.isConnected(),
    entities: configured ? deckHa.snapshot(ha.entities || []) : [],
    energy: configured ? deckHa.snapshot(ha.energyEntities || []) : [],
    // The room order and tile view the user set, in the payload so every open
    // surface (and a widget) redraws from one snapshot, not from a settings
    // re-fetch that may land after it.
    areaOrder: Array.isArray(ha.areaOrder) ? ha.areaOrder : [],
    tileView: typeof ha.tileView === 'string' ? ha.tileView : 'auto',
  };
}

function broadcastHaDeckStates(force) {
  if (!_haDeckWatchClients.size) return;
  const payload = buildHaDeckStates();
  const sig = JSON.stringify(payload);
  if (!force && sig === haWatch.deckStatesLast) return;
  haWatch.deckStatesLast = sig;
  broadcastSSE('ha_states', payload);
}

// `change` is the state_changed data when one arrived: a doorbell's becomes its card at once,
// a door or window opening goes in the home log.
function scheduleHaBroadcast(change) {
  if (change && doorbell.haRing(change)) doorbell.fromHa(change, deckHa).catch(() => {});
  if (change) homeLog.fromHa(change);
  if (haWatch.notifyTimer) return;
  haWatch.notifyTimer = setTimeout(async () => {
    haWatch.notifyTimer = null;
    try {
      const state = await buildHaState();
      const sig = JSON.stringify(state);
      if (sig !== haWatch.stateLast) { haWatch.stateLast = sig; broadcastSSE('homeassistant', state); }
    } catch (e) { /* ignore */ }
    // Same coalesced beat feeds the deck-bound entity states (separate event so
    // the deck snapshot stays tiny and independent of the tile's selection).
    try { broadcastHaDeckStates(false); } catch (e) { /* ignore */ }
  }, 250);
}

module.exports = { buildHaDeckStates, buildHaState, broadcastHaDeckStates, scheduleHaBroadcast };
