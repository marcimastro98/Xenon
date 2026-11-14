// The processor temperature the dashboard shows, from the system's own collectors where there
// are any, otherwise from the sensor service or the sensor script.

const { nativeCollectors } = require('./native-collectors.js');
const { collectorNum, SENSOR_ACCESS } = require('./sensor-values.js');
const { CPU_TEMP_SCRIPT } = require('./script-paths.js');
const { sensorService } = require('../sensor-service/engine-reader.js');
const { runCollector } = require('./pwsh-worker.js');
const { sensorReads } = require('./sensor-reads-state.js');
const { sensorCache } = require('./sensor-cache.js');
const { sensorRateMs } = require('./sensor-rate.js');

async function getCpuTemp() {
  const age = Date.now() - sensorCache.reading.updatedAt;
  if (age < sensorRateMs()) return sensorCache.reading.cpuTemp;
  if (sensorReads.cpuTempPending) return sensorReads.cpuTempPending;

  sensorReads.cpuTempPending = (async () => {
    try {
      const data = nativeCollectors ? await nativeCollectors.cpuTemp() : ((await sensorService.cpu(sensorRateMs())) || await runCollector(CPU_TEMP_SCRIPT, [], 10000));
      // Windows PowerShell 5.1 can unwrap a single-element array on serialize.
      let fans = data.fans;
      if (fans && !Array.isArray(fans)) fans = [fans];
      sensorCache.reading = {
        cpuTemp: data.cpuTemp === null || data.cpuTemp === undefined ? null : Number(data.cpuTemp),
        // The automatic pick's sensor name (Tctl/Tdie, CPU Package), shown by
        // Settings → Sensor sources next to "Automatic". Presentation only.
        cpuTempSource: typeof data.cpuTempSource === 'string' ? data.cpuTempSource.trim().slice(0, 48) || null : null,
        fans: (Array.isArray(fans) ? fans : [])
          .filter(f => f && typeof f === 'object' && collectorNum(f.rpm) !== null)
          // `kind` says where the fan physically is ('psu' = the PSU's own fan,
          // 'ctrl' = an AIO/fan-hub controller); anything the collector doesn't
          // vouch for falls back to a motherboard header.
          .map(f => ({
            name: String(f.name || 'Fan').slice(0, 48),
            rpm: Math.round(collectorNum(f.rpm)),
            kind: f.kind === 'psu' || f.kind === 'ctrl' ? f.kind : 'mb',
          })),
        cpuWatts: collectorNum(data.cpuWatts),
        psuWatts: collectorNum(data.psuWatts),
        // Live core clock in MHz — the fastest core, not an average across them
        // (see cpu-temp.ps1). A platform whose collector cannot read one leaves
        // it null rather than reporting the nominal speed as if it were current.
        cpuClockMHz: collectorNum(data.cpuClockMHz) === null ? null : Math.round(collectorNum(data.cpuClockMHz)),
        sensorAccess: SENSOR_ACCESS.has(data.sensorAccess) ? data.sensorAccess : null,
        updatedAt: Date.now(),
      };
    } catch {
      sensorCache.reading.updatedAt = Date.now();
    }
    sensorReads.cpuTempPending = null;
    return sensorCache.reading.cpuTemp;
  })();

  return sensorReads.cpuTempPending;
}

module.exports = { getCpuTemp };
