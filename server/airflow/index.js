'use strict';
// Airflow in the server: one store, one engine (loop.js), the drivers this PC has
// (drivers.js), the names given in the Fans widget, and what the person is doing
// (a game, a call, a recording) from the situations engine, asked for only while
// Airflow is on. Nothing ticks until Airflow is switched on or a fan check is asked
// for. Loading this file starts nothing: routes.js calls start() once.
const { DATA_DIR } = require('../engine/paths.js');
const { broadcastSSE } = require('../http/sse-clients.js');
const Sources = require('../capabilities/situation-sources.js');
const { readHubSettings } = require('../settings/read.js');
const { createAirflowStore } = require('./store.js');
const { createAirflowLoop } = require('./loop.js');
const { createAirflowLive } = require('./live.js');
const { createRiseNotices } = require('./rise.js');
const { createRiseCause } = require('./rise-cause.js');
const { perfSession } = require('../perf-session/engine-session.js');
const { createEnginePriority } = require('./priority.js');
const { createAirflowActions } = require('./actions.js');
const { driversFor, linkWanted } = require('./drivers.js');
const { createSituation, createLabels } = require('./situation.js');

const warn = (msg) => console.warn(msg);
const store = createAirflowStore({ dataDir: DATA_DIR, warn });
const situation = createSituation({ wanted: () => store.peek() });
const leave = Sources.addSource(situation.source);
const labels = createLabels({ read: readHubSettings });
// Called by the drivers only after `loop` exists (from its ticks).
const wantLink = () => linkWanted(store.peek(), loop.checking());
const platform = driversFor({ dataDir: DATA_DIR, wantLink });
const live = createAirflowLive({ broadcast: broadcastSSE });
// The fans climbed enough to be heard: why and for which program, once, on every screen
// (unless switched off).
const cause = createRiseCause({ read: (o) => perfSession.stats(o), game: () => situation.now(Date.now()).game });
const rise = createRiseNotices({ broadcast: broadcastSSE, cause });
const onStatus = (status) => { live.push(status); rise.push(status, store.peek()); };
// While it holds the fans the engine never waits behind the work that heats the PC.
const enginePriority = createEnginePriority({ warn });
const loop = createAirflowLoop({
  drivers: platform.drivers, none: platform.none, store, labels: labels.get, situation: situation.now, warn, onStatus,
  onDriving: enginePriority.holding,
});

let started = null;
const start = () => (started ??= loop.start().catch((e) => warn(`airflow: could not start (${e.message})`)));
const actions = createAirflowActions({ store, loop, start, hubLights: platform.hubLights, lastRise: rise.last });

/**
 * Whether this PC can have its fans driven at all (the capability `fanControl`): not a
 * Mac, not a laptop (its firmware owns its fans; known after the first read at start).
 */
function available() {
  if (!platform.drivers.length) return false;
  const why = loop.status()?.unavailable || {};
  return !platform.drivers.every((d) => why[d.id] === 'laptop');
}

/** What the Xenon menu's Fans section draws, or null on a PC with no fans to drive. */
async function menuState() {
  return available() ? actions.view() : null;
}

/** Server shutdown: every fan back to the PC, what was learned saved. */
async function stop() {
  leave();
  live.stop();
  try { await loop.stop(); } finally { platform.stop(); }
}

module.exports = { store, loop, actions, start, stop, available, menuState };
