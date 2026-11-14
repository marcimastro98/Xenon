// The processor load as last read.

const { cpuRead } = require('./cpu-usage-state.js');

function getCpuUsage() {
  return cpuRead.usage;
}

module.exports = { getCpuUsage };
