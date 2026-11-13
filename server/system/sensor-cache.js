// The last reading of the CPU temperature, the fans and the power draw.

const sensorCache = {
  reading: { cpuTemp: null, cpuTempSource: null, fans: [], cpuWatts: null, psuWatts: null, cpuClockMHz: null, sensorAccess: null, updatedAt: 0 },
};

module.exports = { sensorCache };
