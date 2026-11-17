// The engine's reader of the memory sticks, asked again after a failed read.

const { RAM_INFO_RETRY_MS } = require('./timings.js');
const { createFactReader } = require('./first-reading.js');
const { readRamInfo } = require('./ram-info.js');

const ramInfo = createFactReader(readRamInfo, { retryMs: RAM_INFO_RETRY_MS });

module.exports = { ramInfo };
