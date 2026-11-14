'use strict';
// The metrics the sensor history keeps, how a reading goes into a bucket, and how buckets are
// averaged.

const METRICS = ['cpu', 'cpuTemp', 'gpu', 'gpuTemp', 'mem', 'cpuWatts', 'gpuWatts'];

function emptyMetrics() {
  const m = {};
  for (const k of METRICS) m[k] = { min: null, max: null, sum: 0, n: 0 };
  return m;
}

function addMetric(slot, value) {
  if (!slot) return; // bucket persisted before a metric existed (e.g. pre-watts stores)
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

module.exports = { METRICS, emptyMetrics, addMetric, localKey, aggregate };
