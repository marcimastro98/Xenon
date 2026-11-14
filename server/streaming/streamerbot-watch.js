// Watching Streamer.bot while a dashboard is open: what it reports is sent on at most four
// times a second, and the watch stops when nobody is looking or no address is set.

const { sseClients, broadcastSSE } = require('../http/sse-clients.js');
const { readHubSettings } = require('../settings/read.js');
const { deckSb } = require('./deck-clients.js');
const { sbWatching } = require('./streamerbot-watching.js');
const { sbWatch } = require('./streamerbot-watch-state.js');
const { pushActivity } = require('./streamerbot-activity.js');

async function buildSbState() {
  const s = (await readHubSettings().catch(() => null)) || {};
  const configured = !!s.streamerbotHost;
  return { configured, connected: configured && deckSb.isConnected(), globals: configured ? deckSb.globalsSnapshot() : {} };
}

// Coalesce bursts of global changes into at most one broadcast per ~250ms (one
// Streamer.bot action can flip several globals at once). Keeps SSE traffic tiny.
function scheduleSbBroadcast() {
  if (sbWatch.notifyTimer) return;
  sbWatch.notifyTimer = setTimeout(async () => {
    sbWatch.notifyTimer = null;
    try { broadcastSSE('streamerbot', await buildSbState()); } catch (e) { /* ignore */ }
  }, 250);
}

async function refreshSbWatch() {
  const s = (await readHubSettings().catch(() => null)) || {};
  const want = !!s.streamerbotHost && sseClients.size > 0;
  if (want && !sbWatching.stop) {
    sbWatching.stop = deckSb.watch(scheduleSbBroadcast, pushActivity);
  } else if (!want && sbWatching.stop) {
    const stopSb = sbWatching.stop; stopSb(); sbWatching.stop = null;
    if (sbWatch.notifyTimer) { clearTimeout(sbWatch.notifyTimer); sbWatch.notifyTimer = null; }
    try { broadcastSSE('streamerbot', await buildSbState()); } catch (e) { /* ignore */ }
  }
}

module.exports = { buildSbState, scheduleSbBroadcast, refreshSbWatch };
