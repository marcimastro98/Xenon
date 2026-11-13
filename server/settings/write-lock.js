// The queue every change to the settings file goes through: one read, change and write finishes
// before the next begins, and one that fails does not block those behind it.

const { settingsStore } = require('./store-state.js');

function withHubSettingsLock(fn) {
  const run = settingsStore.writeChain.then(fn, fn);
  settingsStore.writeChain = run.then(() => {}, () => {});
  return run;
}

module.exports = { withHubSettingsLock };
