// The index of the person's files that the search reads, made when the engine starts: it begins
// to build only after its start delay and when a search or the disk view asks.

const { createLivingIndex } = require('../living-index.js');
const { createLinuxIndex } = require('../linux-index.js');
const { HELPER_EXE } = require('../engine/paths.js');
const { INDEX_START_DELAY_MS } = require('./spotlight-state.js');

const livingIndex = process.platform === 'linux'
  ? createLinuxIndex({ startDelayMs: INDEX_START_DELAY_MS })
  : createLivingIndex({ helperExe: HELPER_EXE, startDelayMs: INDEX_START_DELAY_MS });

module.exports = { livingIndex };
