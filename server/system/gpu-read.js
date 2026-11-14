// Reads the graphics card, one reading at a time, and keeps the last answer.

const { nativeCollectors } = require('./native-collectors.js');
const { collectorNum, normalizeGpuFans } = require('./sensor-values.js');
const { GPU_SCRIPT } = require('./script-paths.js');
const { runCollector } = require('./pwsh-worker.js');
const { sensorReads } = require('./sensor-reads-state.js');
const { sensorRateMs } = require('./sensor-rate.js');

async function getGpuInfo() {
  const age = Date.now() - sensorReads.gpuCache.updatedAt;
  if (age < sensorRateMs()) return sensorReads.gpuCache;
  if (sensorReads.gpuPending) return sensorReads.gpuPending;
  sensorReads.gpuPending = (async () => {
  try {
    const data = nativeCollectors ? await nativeCollectors.gpu() : await runCollector(GPU_SCRIPT, [], 12000);
    sensorReads.gpuCache = {
      gpu: data.gpu === null || data.gpu === undefined ? sensorReads.gpuCache.gpu : data.gpu,
      gpuName: data.gpuName || sensorReads.gpuCache.gpuName || null,
      gpuTemp: (data.gpuTemp === null || data.gpuTemp === undefined) ? sensorReads.gpuCache.gpuTemp : data.gpuTemp,
      vramUsed: (data.vramUsed === null || data.vramUsed === undefined) ? sensorReads.gpuCache.vramUsed : data.vramUsed,
      vramTotal: (data.vramTotal === null || data.vramTotal === undefined) ? sensorReads.gpuCache.vramTotal : data.vramTotal,
      gpuWatts: collectorNum(data.gpuWatts) ?? sensorReads.gpuCache.gpuWatts,
      gpuFanRpm: collectorNum(data.gpuFanRpm) === null ? sensorReads.gpuCache.gpuFanRpm : Math.round(collectorNum(data.gpuFanRpm)),
      gpuFanPct: collectorNum(data.gpuFanPct) === null ? sensorReads.gpuCache.gpuFanPct : Math.round(collectorNum(data.gpuFanPct)),
      // Per-fan RPM straight from the card's tachometers. `null` means the read
      // carried no answer at all (keep the last list); an empty array means the
      // card reported no fans (drop it) — see normalizeGpuFans.
      gpuFans: normalizeGpuFans(data.gpuFans) ?? sensorReads.gpuCache.gpuFans,
      // Core and memory clock in MHz. Held like every other reading here: a read
      // that carried no answer keeps the last one rather than blinking the tile
      // to "—" for a cycle, which is what a card reporting [N/A] intermittently
      // would otherwise do.
      gpuClockMHz: collectorNum(data.gpuClockMHz) === null ? sensorReads.gpuCache.gpuClockMHz : Math.round(collectorNum(data.gpuClockMHz)),
      vramClockMHz: collectorNum(data.vramClockMHz) === null ? sensorReads.gpuCache.vramClockMHz : Math.round(collectorNum(data.vramClockMHz)),
      updatedAt: Date.now(),
    };
  } catch {
    sensorReads.gpuCache.updatedAt = Date.now();
  }
  sensorReads.gpuPending = null;
  return sensorReads.gpuCache;
  })();
  return sensorReads.gpuPending;
}

module.exports = { getGpuInfo };
