// The sensor readings under way and the last ones kept: the processor's temperature, the
// graphics card and the sensors the user chose.

const sensorReads = {
  gpuCache: { gpu: null, gpuName: null, gpuTemp: null, vramUsed: null, vramTotal: null, gpuWatts: null, gpuFanRpm: null, gpuFanPct: null, gpuFans: [], gpuClockMHz: null, vramClockMHz: null, updatedAt: 0 },
  gpuPending: null,
  cpuTempPending: null,
  // The chosen sensors' readings, at the same cadence as the readings they
  // replace. Nothing chosen = nothing read: an install that never opened the
  // picker pays nothing for this feature.
  chosen: { key: '', readings: null, at: 0 },
  chosenPending: null,
};

module.exports = { sensorReads };
