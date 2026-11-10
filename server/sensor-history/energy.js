'use strict';
// Energy from the sensor history: watt-hours per hour and per day bucket, kept
// beside the averages guardian.js already stores. An average of watts cannot
// give kWh by itself (the PC may have been off for half the day), so each
// reading adds watts x the time it stands for, and the bucket also counts the
// seconds it covers.
//
// Sources: `cpu` and `gpu` (package and board draw, always partial) and `psu`
// (what a digital power supply reports it delivers, the whole PC). A reading
// stands for the gap since the previous one, never more than the interval: a
// sleep or a restart in between credits one interval, not the hours the PC was
// off. Persisted buckets are read back through energyOf(), field by field.

const SOURCES = Object.freeze(['cpu', 'gpu', 'psu']);
const SLACK_MS = 5 * 1000;
const MAX_WATTS = 5000; // nothing a PC part reports above this is a real draw
const HOUR_MS = 60 * 60 * 1000;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const watts = (v) => (finite(v) && v >= 0 && v <= MAX_WATTS ? v : null);
const round2 = (v) => Math.round(v * 100) / 100;

// How many ms the reading taken at `now` stands for.
function creditMs(prevAt, now, intervalMs) {
  if (!finite(intervalMs) || intervalMs <= 0) return 0;
  if (!finite(prevAt) || prevAt <= 0 || now <= prevAt) return intervalMs;
  return Math.min(now - prevAt, intervalMs + SLACK_MS);
}

// Adds the reading's energy to one bucket (`e`: Wh per source, `s`: seconds).
function credit(bucket, reading, ms) {
  if (!bucket || !(ms > 0)) return false;
  const w = reading && typeof reading === 'object' ? reading : {};
  const e = bucket.e && typeof bucket.e === 'object' ? bucket.e : {};
  let any = false;
  for (const k of SOURCES) {
    const v = watts(w[k]);
    if (v == null) continue;
    e[k] = (finite(e[k]) && e[k] >= 0 ? e[k] : 0) + (v * ms) / HOUR_MS;
    any = true;
  }
  if (!any) return false;
  e.s = (finite(e.s) && e.s >= 0 ? e.s : 0) + ms / 1000;
  bucket.e = e;
  return true;
}

// The live draw of one reading, in W, as plain numbers.
function drawOf(reading) {
  const w = reading && typeof reading === 'object' ? reading : {};
  const out = {};
  for (const k of SOURCES) out[k] = watts(w[k]) == null ? null : Math.round(w[k] * 10) / 10;
  return out;
}

// A bucket's energy as plain numbers: Wh per source (null when never read)
// and the seconds covered.
function energyOf(bucket) {
  const e = bucket && bucket.e && typeof bucket.e === 'object' ? bucket.e : {};
  const out = {};
  for (const k of SOURCES) out[k] = finite(e[k]) && e[k] >= 0 ? round2(e[k]) : null;
  out.covered = finite(e.s) && e.s >= 0 ? Math.round(e.s) : 0;
  return out;
}

// One point per bucket, oldest first; `t` is the bucket's local key
// ("2026-11-08" for a day, "2026-11-08T14" for an hour).
function series(list, keyName) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((b) => b && typeof b[keyName] === 'string' && /^\d{4}-\d{2}-\d{2}(T\d{2})?$/.test(b[keyName]))
    .map((b) => ({ t: b[keyName], ...energyOf(b) }));
}

// What the PC drew in a point, in Wh: the power supply's figure when it has
// one, otherwise CPU + GPU. `whole` says which.
function totalOf(point) {
  if (point && point.psu != null) return { wh: point.psu, whole: true };
  const parts = [point && point.cpu, point && point.gpu].filter((v) => v != null);
  return parts.length ? { wh: round2(parts.reduce((a, b) => a + b, 0)), whole: false } : { wh: null, whole: false };
}

const kwh = (wh) => (wh == null ? null : Math.round(wh) / 1000);

// For Bit: today, yesterday, this month and the last 30 days in kWh, and the
// last 7 days one by one. `today` is the local day key of now.
function summary(days, today) {
  const pts = series(days, 'd');
  const sum = (list) => {
    let wh = 0;
    let seen = false;
    let whole = list.length > 0;
    for (const p of list) {
      const t = totalOf(p);
      if (t.wh == null) continue;
      wh += t.wh;
      seen = true;
      if (!t.whole) whole = false;
    }
    return { kwh: seen ? kwh(wh) : null, wholePc: seen && whole };
  };
  const day = (key) => pts.find((p) => p.t === key);
  const prev = new Date(`${today}T12:00:00`);
  prev.setDate(prev.getDate() - 1);
  const p2 = (n) => String(n).padStart(2, '0');
  const yKey = `${prev.getFullYear()}-${p2(prev.getMonth() + 1)}-${p2(prev.getDate())}`;
  const one = (p) => (p ? { ...sum([p]), hoursCovered: Math.round((p.covered / 3600) * 10) / 10 } : null);
  return {
    today: one(day(today)),
    yesterday: one(day(yKey)),
    thisMonth: sum(pts.filter((p) => p.t.slice(0, 7) === today.slice(0, 7))),
    last30Days: sum(pts.slice(-30)),
    last7Days: pts.slice(-7).map((p) => ({ date: p.t, kwh: kwh(totalOf(p).wh) })),
    daysRecorded: pts.filter((p) => p.covered > 0).length,
  };
}

module.exports = { SOURCES, creditMs, credit, drawOf, energyOf, series, totalOf, summary };
