// Watching the Elgato Wave Link mixer while a dashboard is open: what it reports is sent on a
// few times a second at most, and the watch stops when nobody is looking or the mixer is
// switched off in the settings.

const { WL_OFF_STATE } = require('./wavelink-values.js');
const { sseClients, broadcastSSE } = require('../http/sse-clients.js');
const { readHubSettings } = require('../settings/read.js');
const { deckWaveLink } = require('./mixer-clients.js');
const { wlWatching } = require('./wavelink-watching.js');
const { wlWatch } = require('./wavelink-watch-state.js');

async function buildWlState() {
  const s = (await readHubSettings().catch(() => null)) || {};
  const enabled = !!(s.wavelink && s.wavelink.enabled === true);
  if (!enabled) return Object.assign({}, WL_OFF_STATE);
  return Object.assign({ enabled: true }, deckWaveLink.snapshot());
}

// Coalesce bursts of mixer changes (a single fader move fires several pushes,
// and on 3.x the level meters add ~2 frames a second) into at most one
// broadcast per ~150ms. The state is small by construction — channel artwork is
// served by URL and never enters this frame.
function scheduleWlBroadcast() {
  if (wlWatch.notifyTimer) return;
  wlWatch.notifyTimer = setTimeout(async () => {
    wlWatch.notifyTimer = null;
    try { broadcastSSE('wavelink', await buildWlState()); } catch (e) { /* ignore */ }
  }, 150);
}

async function refreshWlWatch() {
  const s = (await readHubSettings().catch(() => null)) || {};
  const want = !!(s.wavelink && s.wavelink.enabled === true) && sseClients.size > 0;
  if (want && !wlWatching.stop) {
    // Level meters are asked for only while a dashboard is actually connected,
    // and switched off again on teardown: subscribing leaves Wave Link pushing
    // at ~2Hz forever otherwise, which is the "periodic work with no listener"
    // this codebase gates everywhere else. 2.x has no meters and ignores it.
    wlWatching.stop = deckWaveLink.watch(scheduleWlBroadcast, { meters: true });
  } else if (!want && wlWatching.stop) {
    const stopWl = wlWatching.stop; stopWl(); wlWatching.stop = null;
    if (wlWatch.notifyTimer) { clearTimeout(wlWatch.notifyTimer); wlWatch.notifyTimer = null; }
    try { broadcastSSE('wavelink', await buildWlState()); } catch (e) { /* ignore */ }
  }
}

module.exports = { buildWlState, scheduleWlBroadcast, refreshWlWatch };
