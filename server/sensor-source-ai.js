'use strict';
// sensor_source: Bit picks which hardware sensor a headline reading comes from
// (Settings → Performance → Sensor sources), e.g. "use the CPU package sensor for
// the temperature". Pure: the server reads the catalog through the collector
// seam and writes the choice under the settings lock. A sensor is only ever
// chosen from what the collectors enumerated on this PC, never from an id the
// model made up, so the same rule as the Settings picker holds.

const SensorSources = require('./js/sensor-sources.js');

const METRICS = Object.freeze(Object.keys(SensorSources.SENSOR_METRICS));
const LIST_MAX = 40;

function candidates(metric, catalog) {
  const type = SensorSources.SENSOR_METRICS[metric];
  return (Array.isArray(catalog) ? catalog : [])
    .filter((s) => s && s.type === type)
    .slice(0, LIST_MAX)
    .map((s) => ({ id: s.id, device: s.hw, name: s.name, value: s.value, unit: s.unit }));
}

// → { read: true } | { list: metric } | { metric, sensor } (sensor '' = Automatic)
//   | { error, ... }. `catalog` is only needed to check a chosen id.
function plan(args, catalog) {
  const a = args || {};
  if (a.metric == null || a.metric === '') return { read: true };
  const metric = String(a.metric);
  if (!METRICS.includes(metric)) return { error: 'unknown_metric', allowed: METRICS.slice() };
  const sensor = String(a.sensor == null ? '' : a.sensor).trim();
  if (!sensor) return { list: metric };
  if (/^(auto|automatic)$/i.test(sensor)) return { metric, sensor: '' };
  if (!candidates(metric, catalog).some((c) => c.id === sensor)) {
    return { error: 'unknown_sensor', hint: 'Call sensor_source with this metric and no sensor for the ids this PC has.' };
  }
  return { metric, sensor };
}

// The settings field after the choice: Automatic removes the key.
function nextSources(current, p) {
  const out = { ...SensorSources.normalizeSensorSources(current) };
  if (p.sensor) out[p.metric] = p.sensor;
  else delete out[p.metric];
  return out;
}

module.exports = { METRICS, candidates, plan, nextSources };
