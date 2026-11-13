// Checks the saved settings of the PC numbers: the names given to fans and how often sensors
// are read.

// How often the sensor readings refresh, in ms. 5000 is the cadence everything
// was built around and stays the default; the two faster steps are opt-in and
// say what they cost, because the cost is real (see SENSOR_RATES).
const SENSOR_RATE_MS = Object.freeze([5000, 2000, 1000]);
function normalizeSensorRate(value) {
  const n = Math.round(Number(value));
  return SENSOR_RATE_MS.includes(n) ? n : 5000;
}

// Mirror of the client's normalizeFanLabels (settings.js): explicit bounded
// rebuild of the flat { "<kind>|<sensor name>": "label" } rename map.
function normalizeServerFanLabels(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  let n = 0;
  for (const key of Object.keys(v)) {
    if (n >= 64) break;
    if (typeof key !== 'string' || key.length > 60 || !key.includes('|')) continue;
    const label = typeof v[key] === 'string' ? v[key].trim().slice(0, 32) : '';
    if (!label) continue;
    out[key] = label;
    n++;
  }
  return out;
}


module.exports = { SENSOR_RATE_MS, normalizeSensorRate, normalizeServerFanLabels };
