'use strict';

// ── Guardian — long-term hardware health history (opt-in) ───────────────────
// While enabled (Settings → Funzioni AI → Guardian), samples the system
// sensors every few minutes and aggregates them into hourly buckets and daily
// rollups persisted in data/guardian.json. Collection is fully local and free;
// the AI analysis happens only when the user asks Xenon (guardian_report tool).
// While the feature is OFF the tick is a single boolean check — no sensors
// are read and nothing is written.

const fs = require('fs');
const path = require('path');

const SAMPLE_MS = 5 * 60 * 1000; // one sensor sample every 5 minutes
const MAX_HOURS = 72;            // keep 3 days of hourly buckets
const MAX_DAYS = 90;             // keep ~3 months of daily rollups

// Alert thresholds (°C / % RAM) with a cooldown so toasts don't spam.
const ALERT_CPU_TEMP = 90;
const ALERT_GPU_TEMP = 88;
const ALERT_MEM_PCT = 95;
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

const METRICS = ['cpu', 'cpuTemp', 'gpu', 'gpuTemp', 'mem'];

function emptyMetrics() {
  const m = {};
  for (const k of METRICS) m[k] = { min: null, max: null, sum: 0, n: 0 };
  return m;
}

function addMetric(slot, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  slot.min = slot.min == null ? value : Math.min(slot.min, value);
  slot.max = slot.max == null ? value : Math.max(slot.max, value);
  slot.sum += value;
  slot.n += 1;
}

function localKey(date, withHour) {
  const p = (n) => String(n).padStart(2, '0');
  const base = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  return withHour ? `${base}T${p(date.getHours())}` : base;
}

// Average/max of one metric across a list of buckets.
function aggregate(buckets, metric) {
  let sum = 0, n = 0, max = null;
  for (const b of buckets) {
    const m = b.m && b.m[metric];
    if (!m || !m.n) continue;
    sum += m.sum; n += m.n;
    if (m.max != null) max = max == null ? m.max : Math.max(max, m.max);
  }
  if (!n) return { avg: null, max: null };
  return { avg: Math.round((sum / n) * 10) / 10, max: Math.round(max * 10) / 10 };
}

function createGuardian({ dataDir, getSystemInfo, isEnabled, onAlert }) {
  const FILE = path.join(dataDir, 'guardian.json');
  let store = null; // { hours: [{h, m}], days: [{d, m}] }
  let timer = null;
  let sampling = false;
  const lastAlertAt = { cpu: 0, gpu: 0, mem: 0 };

  function normalizeStore(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
      hours: Array.isArray(src.hours) ? src.hours.slice(-MAX_HOURS) : [],
      days: Array.isArray(src.days) ? src.days.slice(-MAX_DAYS) : [],
    };
  }

  async function load() {
    if (store) return store;
    try {
      store = normalizeStore(JSON.parse(await fs.promises.readFile(FILE, 'utf8')));
    } catch {
      store = { hours: [], days: [] };
    }
    return store;
  }

  async function persist() {
    if (!store) return;
    try { await fs.promises.writeFile(FILE, JSON.stringify(store), 'utf8'); }
    catch (e) { console.error('Guardian persist failed:', e.message); }
  }

  function bucketFor(list, keyName, key) {
    let b = list.length ? list[list.length - 1] : null;
    if (!b || b[keyName] !== key) {
      b = { [keyName]: key, m: emptyMetrics() };
      list.push(b);
    }
    return b;
  }

  function maybeAlert(type, value, threshold) {
    if (typeof value !== 'number' || value < threshold) return;
    const now = Date.now();
    if (now - lastAlertAt[type] < ALERT_COOLDOWN_MS) return;
    lastAlertAt[type] = now;
    try { onAlert({ type, value: Math.round(value) }); } catch { /* alert is best-effort */ }
  }

  async function sample() {
    if (sampling) return;
    sampling = true;
    try {
      const sys = await getSystemInfo();
      await load();
      const now = new Date();
      const reading = {
        cpu: typeof sys.cpu === 'number' ? sys.cpu : null,
        cpuTemp: typeof sys.cpuTemp === 'number' ? sys.cpuTemp : null,
        gpu: typeof sys.gpu === 'number' ? sys.gpu : null,
        gpuTemp: typeof sys.gpuTemp === 'number' ? sys.gpuTemp : null,
        mem: sys.memory && typeof sys.memory.percent === 'number' ? sys.memory.percent : null,
      };
      const hour = bucketFor(store.hours, 'h', localKey(now, true));
      const day = bucketFor(store.days, 'd', localKey(now, false));
      for (const k of METRICS) {
        addMetric(hour.m[k], reading[k]);
        addMetric(day.m[k], reading[k]);
      }
      if (store.hours.length > MAX_HOURS) store.hours = store.hours.slice(-MAX_HOURS);
      if (store.days.length > MAX_DAYS) store.days = store.days.slice(-MAX_DAYS);
      await persist();
      maybeAlert('cpu', reading.cpuTemp, ALERT_CPU_TEMP);
      maybeAlert('gpu', reading.gpuTemp, ALERT_GPU_TEMP);
      maybeAlert('mem', reading.mem, ALERT_MEM_PCT);
    } catch (e) {
      console.error('Guardian sample failed:', e.message);
    } finally {
      sampling = false;
    }
  }

  // Compact deterministic digest for the AI: averages/maxima over the last
  // 24h / 7d / 30d plus 7d-vs-30d deltas. Computed locally, zero API cost.
  async function getDigest() {
    await load();
    const h24 = store.hours.slice(-24);
    const d7 = store.days.slice(-7);
    const d30 = store.days.slice(-30);
    const windowStats = (buckets) => ({
      cpuLoad: aggregate(buckets, 'cpu'),
      cpuTemp: aggregate(buckets, 'cpuTemp'),
      gpuLoad: aggregate(buckets, 'gpu'),
      gpuTemp: aggregate(buckets, 'gpuTemp'),
      memPercent: aggregate(buckets, 'mem'),
    });
    const s7 = windowStats(d7);
    const s30 = windowStats(d30);
    const delta = (a, b) => (a.avg != null && b.avg != null) ? Math.round((a.avg - b.avg) * 10) / 10 : null;
    return {
      collectedDays: store.days.length,
      collectedHours: store.hours.length,
      last24h: windowStats(h24),
      last7d: s7,
      last30d: s30,
      trend7dVs30d: {
        cpuTempDelta: delta(s7.cpuTemp, s30.cpuTemp),
        gpuTempDelta: delta(s7.gpuTemp, s30.gpuTemp),
        memPercentDelta: delta(s7.memPercent, s30.memPercent),
      },
    };
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      if (!isEnabled()) return; // disabled → just a boolean check, zero cost
      sample();
    }, SAMPLE_MS);
    timer.unref();
  }

  return { start, sample, getDigest };
}

module.exports = { createGuardian };
