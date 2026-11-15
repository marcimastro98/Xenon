// The list of sensors and the readings of the ones the person chose, the sensor service's rows
// merged with what the sensor script reads.

const { nativeCollectors } = require('./native-collectors.js');
const { POWERSHELL_SUPPORTED } = require('../powershell/supported.js');
const { parseJsonOutput } = require('../powershell/read-json.js');
const SensorSources = require('../js/system/sensor-sources.js');
const { sensorService } = require('../sensor-service/engine-reader.js');
const { SENSORS_SCRIPT } = require('./script-paths.js');
const { runPowerShellWorker } = require('./pwsh-worker.js');
const { sensorReads } = require('./sensor-reads-state.js');
const { sensorRateMs } = require('./sensor-rate.js');

// ── Sensor sources ──────────────────────────────────────────────────────────
// The catalog of every sensor the collectors can read (Settings → Sensor
// sources, the SDK `sensors` stream), and the chosen ones read for
// getSystemInfo. Through the collector seam on macOS/Linux, the worker on
// Windows. `ids` null = the whole catalog. `known: false` means no answer
// (worker gone, LHM sessions not open yet), which applySensorSources must not
// mistake for "the sensor is gone".
async function collectSensors(ids) {
  if (nativeCollectors) {
    if (typeof nativeCollectors.listSensors !== 'function') return { known: true, sensors: [] };
    const raw = ids ? await nativeCollectors.readSensors(ids) : await nativeCollectors.listSensors();
    return { known: true, sensors: SensorSources.normalizeSensorCatalog(raw) };
  }
  if (!POWERSHELL_SUPPORTED) return { known: true, sensors: [] };
  // The worker only: sensors.ps1 walks the LHM sessions that live there, so a
  // one-shot spawn would answer an empty list that looks like a sensorless PC.
  const raw = await sensorService.mergeSensors(parseJsonOutput(await runPowerShellWorker(SENSORS_SCRIPT, ids ? ['read', ids.join('|')] : ['list'], 8000)), ids);
  if (!raw || raw.ok !== true) return { known: false, sensors: [] };
  const list = Array.isArray(raw.sensors) ? raw.sensors : (raw.sensors ? [raw.sensors] : []);
  return { known: raw.lhm === true, sensors: SensorSources.normalizeSensorCatalog(list) };
}

function readChosenSensors(sources) {
  const ids = [...new Set(Object.values(sources))];
  if (!ids.length) return Promise.resolve([]);
  const key = ids.join('|');
  if (key === sensorReads.chosen.key && Date.now() - sensorReads.chosen.at < sensorRateMs()) return Promise.resolve(sensorReads.chosen.readings);
  if (sensorReads.chosenPending) return sensorReads.chosenPending;
  sensorReads.chosenPending = collectSensors(ids)
    .then((r) => (r.known ? r.sensors : null))
    .catch(() => null)
    .then((readings) => {
      // A failed read keeps the last good one for the same choice, so a worker
      // restart does not blink the tile back to the automatic sensor.
      const keep = readings === null && key === sensorReads.chosen.key ? sensorReads.chosen.readings : readings;
      sensorReads.chosen = { key, readings: keep, at: Date.now() };
      return keep;
    })
    .finally(() => { sensorReads.chosenPending = null; });
  return sensorReads.chosenPending;
}



module.exports = { collectSensors, readChosenSensors };
