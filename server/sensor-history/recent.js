'use strict';
// The last few hours of sensor history at full resolution: one entry per sample,
// beside the hourly and daily averages guardian.js keeps for the long view. An
// hourly average flattens a two-minute spike; this keeps it, for the "6h" chart.
//
// Entries are { at: epoch ms, v: { cpu, cpuTemp, … } } with plain numbers or
// null. Bounded by age (RECENT_HOURS) and by count (one a minute at most), and
// rebuilt from the known shape when read back from disk.

const RECENT_HOURS = 6;
const RECENT_MS = RECENT_HOURS * 60 * 60 * 1000;
const RECENT_MAX = RECENT_HOURS * 60;

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function cleanReading(raw, metrics) {
  const v = {};
  for (const k of metrics) v[k] = num(raw && raw[k]);
  return v;
}

function trim(list, now) {
  const from = now - RECENT_MS;
  let start = 0;
  while (start < list.length && list[start].at < from) start++;
  const kept = start ? list.slice(start) : list;
  return kept.length > RECENT_MAX ? kept.slice(-RECENT_MAX) : kept;
}

// Persisted data → only well-formed, ordered entries inside the window.
function normalizeRecent(raw, metrics, now = Date.now()) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw.slice(-RECENT_MAX)) {
    if (!e || typeof e !== 'object' || !Number.isFinite(e.at) || e.at > now) continue;
    if (out.length && e.at <= out[out.length - 1].at) continue;
    out.push({ at: e.at, v: cleanReading(e.v, metrics) });
  }
  return trim(out, now);
}

function pushRecent(list, reading, metrics, now = Date.now()) {
  const next = Array.isArray(list) ? list.slice() : [];
  if (next.length && next[next.length - 1].at >= now) return trim(next, now);
  next.push({ at: now, v: cleanReading(reading, metrics) });
  return trim(next, now);
}

// 'YYYY-MM-DDTHH:MM' in local time, the key format the charts read
// (js/history-chart.js bucketDate).
function minuteKey(at) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// The same point shape as guardian.js series(): one sample is its own average
// and its own peak.
function recentSeries(list, metrics) {
  return (Array.isArray(list) ? list : []).map((e) => {
    const point = { t: minuteKey(e.at) };
    for (const k of metrics) point[k] = e.v[k] == null ? null : { avg: e.v[k], max: e.v[k] };
    return point;
  });
}

module.exports = { RECENT_HOURS, RECENT_MAX, normalizeRecent, pushRecent, recentSeries, minuteKey };
