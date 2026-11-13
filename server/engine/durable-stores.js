// The files that hold what the user made (settings, Deck, notes, tasks, events, timers), what
// was recovered from a copy at start, and the daily copy of each.

const { DATA_DIR } = require('./paths.js');
const { SETTINGS_FILE } = require('../settings/settings-file.js');
const { NOTES_JSON, EVENTS_FILE, TASKS_FILE, TIMERS_FILE } = require('../time/store-files.js');
const { DECK_FILE } = require('../deck/deck-file.js');
const storeSnapshots = require('../store-snapshots.js');

const DURABLE_STORES = [SETTINGS_FILE, DECK_FILE, NOTES_JSON, TASKS_FILE, EVENTS_FILE, TIMERS_FILE];
const _storeRecovery = [];

// One copy a day of every store, taken at boot and checked every few hours.
function startStoreSnapshots() {
  const run = () => storeSnapshots.snapshotStores(DATA_DIR, DURABLE_STORES).catch(() => {});
  run();
  setInterval(run, 6 * 60 * 60 * 1000).unref();
}

module.exports = { DURABLE_STORES, _storeRecovery, startStoreSnapshots };
