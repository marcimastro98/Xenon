// Which hardware sensor each headline reading comes from (Settings →
// Performance → Sensor sources), and the shape of the sensor catalog the
// collectors enumerate. Pure functions shared by the browser (settings.js and
// the picker) and the server (normalizeHubSettings, getSystemInfo, the SDK
// `sensors` stream), so a choice is read by one rule everywhere.
//
//   sensorSources: { cpuTemp?: id, gpuTemp?: id, cpuWatts?: id, gpuWatts?: id }
//                  A missing key means Automatic, which is what every install
//                  had before this existed, so {} is both the default and the
//                  reset.
//   catalog entry: { id, hw, hwKind, type, name, value, unit }
//
// An id is an opaque name the collector gave the sensor (LibreHardwareMonitor's
// identifier on Windows, chip@device/file on Linux). It is never a path the
// server opens: a collector only ever matches it against what it enumerated.

(function (root) {
  // Metric → the sensor type that may feed it. Extending the feature to a new
  // reading is one line here plus where getSystemInfo puts it (setMetric).
  const SENSOR_METRICS = Object.freeze({ cpuTemp: 'temperature', gpuTemp: 'temperature', cpuWatts: 'power', gpuWatts: 'power' });
  const SENSOR_TYPES = Object.freeze(['temperature', 'fan', 'power', 'clock', 'load']);
  const SENSOR_HW_KINDS = Object.freeze(['cpu', 'gpu', 'board', 'storage', 'cooler', 'psu', 'memory', 'other']);
  const SENSOR_UNITS = Object.freeze({ temperature: '°C', fan: 'RPM', power: 'W', clock: 'MHz', load: '%' });
  // LHM identifiers look like /amdcpu/0/temperature/2 or /lpc/nct6798d/0/fan/1;
  // Linux ids like hwmon/k10temp@0000:00:18.3/temp1. '|' stays out: it is the
  // separator when ids travel as one collector argument.
  const SENSOR_ID_RE = /^[A-Za-z0-9/_.:{}@+-]{1,160}$/;
  const SENSOR_CATALOG_MAX = 400;
  const NAME_MAX = 64;
  // What a reading must look like before it may replace a headline number. A
  // sensor that reads 0 or 255 (unelevated LHM, a disconnected probe) is not a
  // temperature, and showing it would be worse than showing nothing.
  const PLAUSIBLE = Object.freeze({ temperature: [1, 150], power: [0, 2000] });

  function isSensorId(v) { return typeof v === 'string' && SENSOR_ID_RE.test(v); }

  function normalizeSensorSources(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const metric of Object.keys(SENSOR_METRICS)) {
      if (isSensorId(raw[metric])) out[metric] = raw[metric];
    }
    return out;
  }

  const text = (v) => (typeof v === 'string' ? v.trim().slice(0, NAME_MAX) : '');

  function normalizeSensorEntry(raw) {
    if (!raw || typeof raw !== 'object' || !isSensorId(raw.id)) return null;
    const type = SENSOR_TYPES.includes(raw.type) ? raw.type : null;
    if (!type) return null;
    const n = Number(raw.value);
    const value = raw.value === null || raw.value === undefined || raw.value === '' || !Number.isFinite(n) ? null : Math.round(n * 10) / 10;
    return {
      id: raw.id,
      hw: text(raw.hw),
      hwKind: SENSOR_HW_KINDS.includes(raw.hwKind) ? raw.hwKind : 'other',
      type,
      name: text(raw.name) || raw.id.slice(-NAME_MAX),
      value,
      unit: SENSOR_UNITS[type],
    };
  }

  // The collector's list rebuilt explicitly: bounded, de-duplicated, every
  // string cut to size. Its names reach third-party widgets through the
  // `sensors` stream, so they are data to be rendered with textContent there.
  function normalizeSensorCatalog(raw) {
    const out = [];
    const seen = new Set();
    for (const r of Array.isArray(raw) ? raw : []) {
      const e = normalizeSensorEntry(r);
      if (!e || seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
      if (out.length >= SENSOR_CATALOG_MAX) break;
    }
    return out;
  }

  function plausible(type, value) {
    const range = PLAUSIBLE[type];
    return typeof value === 'number' && (!range || (value >= range[0] && value <= range[1]));
  }

  function setMetric(info, metric, value) {
    if (metric === 'cpuTemp') info.cpuTemp = value;
    else if (metric === 'gpuTemp') info.gpuTemp = value === null ? null : Math.round(value);
    else if (info.power && typeof info.power === 'object') info.power[metric === 'cpuWatts' ? 'cpu' : 'gpu'] = value;
  }

  // Puts the chosen sensors' readings over the automatic ones in a system
  // payload and says, per metric, where the number came from. A chosen sensor
  // the machine no longer has (a swapped card) falls back to Automatic and is
  // flagged `missing`, so the UI can say so instead of showing a silent zero.
  // `readings` is the collector's answer for the chosen ids, or null when there
  // is no answer yet (a worker restarting, LHM not open yet): then the automatic
  // reading stands without the `missing` flag, which would be a false alarm.
  // `autoNames` is the name of the sensor the automatic pick used, where the
  // collector knows it.
  function applySensorSources(info, sources, readings, autoNames) {
    const known = Array.isArray(readings);
    const byId = new Map(normalizeSensorCatalog(readings).map((r) => [r.id, r]));
    const names = autoNames && typeof autoNames === 'object' ? autoNames : {};
    const chosen = normalizeSensorSources(sources);
    const described = {};
    for (const [metric, type] of Object.entries(SENSOR_METRICS)) {
      const auto = { auto: true, name: text(names[metric]) };
      const id = chosen[metric];
      if (!id) { described[metric] = auto; continue; }
      const r = byId.get(id);
      if (!r || r.type !== type) { described[metric] = known ? { ...auto, id, missing: true } : { ...auto, id }; continue; }
      setMetric(info, metric, plausible(type, r.value) ? r.value : null);
      described[metric] = { auto: false, id, name: r.name, hw: r.hw };
    }
    const p = info.power;
    if (p && typeof p === 'object') {
      p.total = typeof p.cpu === 'number' && typeof p.gpu === 'number' ? Math.round((p.cpu + p.gpu) * 10) / 10 : null;
    }
    info.sensorSources = described;
    return info;
  }

  const api = {
    SENSOR_METRICS, SENSOR_TYPES, SENSOR_HW_KINDS, SENSOR_UNITS, SENSOR_CATALOG_MAX,
    isSensorId, normalizeSensorSources, normalizeSensorEntry, normalizeSensorCatalog, applySensorSources, plausible,
  };
  if (root) root.SensorSources = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
