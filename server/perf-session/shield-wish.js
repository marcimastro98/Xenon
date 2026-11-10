'use strict';
// What Core Shield should do on this status tick, from the saved session and what the
// game detector sees. `session` outlives the game; `on` does not.

const { normalizePerformance, perfActivityApps } = require('../js/perf-settings.js');

const NO_SESSION = Object.freeze({ session: false, on: false });
// Whatever the user streams or meets with fails out loud when it runs late.
const KEEP_ACTIVITIES = Object.freeze(['streaming', 'meeting']);

function shieldWish(performance, game) {
  if (!performance || performance.active !== true) return NO_SESSION;
  const perf = normalizePerformance(performance);
  return {
    session: true,
    on: perf.applied.shield && game.running,
    gamePid: game.pid,
    gameName: game.name,
    foregroundPid: game.foregroundPid,
    keep: new Set(KEEP_ACTIVITIES.flatMap((activity) => perfActivityApps(perf, activity))),
  };
}

module.exports = { shieldWish };
