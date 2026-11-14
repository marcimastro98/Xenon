'use strict';
// What the sensor history answers when it is asked: the charts, the energy, one metric over
// time and the digest.

const Recent = require('./recent.js');
const Energy = require('./energy.js');
const { METRICS, localKey, aggregate } = require('./guardian-metrics.js');

function makeAnswers({ isEnabled, state, everyMin, load }) {
  // Per-bucket time series for the UI history charts: one point per bucket with
  // the average + max of each metric (null when a bucket has no samples for it).
  function series(list, keyName) {
    return list.map(b => {
      const point = { t: b[keyName] };
      for (const k of METRICS) {
        const m = b.m && b.m[k];
        point[k] = (m && m.n)
          ? { avg: Math.round((m.sum / m.n) * 10) / 10, max: m.max != null ? Math.round(m.max * 10) / 10 : null }
          : null;
      }
      return point;
    });
  }

  // Top foreground apps over the last `dayCount` daily buckets, most-used first,
  // with total active time and the game-only share ("PC Screen Time").
  function appsInRange(dayCount) {
    const buckets = state.store.apps.slice(-dayCount);
    const totals = {}; // name -> { s, g }
    let total = 0, gameTotal = 0;
    for (const b of buckets) {
      if (!b || !b.a) continue;
      for (const name of Object.keys(b.a)) {
        const e = b.a[name];
        const s = (e && typeof e.s === 'number') ? e.s : 0;
        if (s <= 0) continue;
        const t = totals[name] || (totals[name] = { s: 0, g: 0 });
        t.s += s;
        if (e.g) t.g = 1;
        total += s;
        if (e.g) gameTotal += s;
      }
    }
    const apps = Object.keys(totals)
      .map(name => ({ name, seconds: Math.round(totals[name].s), game: !!totals[name].g }))
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 12);
    return { total: Math.round(total), gameTotal: Math.round(gameTotal), apps };
  }

  // Full hourly (72h) + daily (90d) history for the dashboard charts, plus the
  // foreground-app usage rollup. The same local data the AI digest summarises —
  // exposed so the user can SEE the trends without asking Xenon. Read-only; cheap
  // (a map over the in-memory buckets).
  async function getHistory() {
    await load();
    return {
      enabled: isEnabled(),
      collectedHours: state.store.hours.length,
      collectedDays: state.store.days.length,
      sampleMinutes: everyMin(),
      // The last hours at the sampling resolution, for the "6h" range.
      recent: Recent.recentSeries(Recent.normalizeRecent(state.store.recent, METRICS), METRICS),
      hours: series(state.store.hours, 'h'),
      days: series(state.store.days, 'd'),
      usage: {
        // Ranges mirror the chart switcher; app buckets are daily, so 24h ≈ today.
        ranges: { '24h': appsInRange(1), '7d': appsInRange(7), '30d': appsInRange(30) },
      },
    };
  }

  // Energy per hour (72 h) and per day (90 days) in Wh, for the SDK `energy`
  // stream (sensor-history/routes.js), and the kWh summary Bit reads.
  async function getEnergy() {
    await load();
    return {
      enabled: isEnabled(),
      sampleMinutes: everyMin(),
      now: state.lastDraw,
      hours: Energy.series(state.store.hours, 'h'),
      days: Energy.series(state.store.days, 'd'),
    };
  }

  async function getEnergySummary() {
    await load();
    return { enabled: isEnabled(), ...Energy.summary(state.store.days, localKey(new Date(), false)) };
  }

  // Targeted history query for the AI: one metric, broken down so the model can
  // answer "was my GPU hotter yesterday than today?", "what was my worst day
  // this month?", "how's the trend?" — without dumping the whole series. Local,
  // zero API cost. Accepts friendly metric names (gpu temp, ram, cpu load…).
  async function queryHistory(metricArg) {
    await load();
    const alias = {
      cpu: 'cpu', cpuload: 'cpu', cpupercent: 'cpu', processor: 'cpu',
      cputemp: 'cpuTemp', cputemperature: 'cpuTemp',
      gpu: 'gpu', gpuload: 'gpu', gpupercent: 'gpu', graphics: 'gpu',
      gputemp: 'gpuTemp', gputemperature: 'gpuTemp',
      mem: 'mem', memory: 'mem', ram: 'mem', mempercent: 'mem',
      cpuwatts: 'cpuWatts', cpupower: 'cpuWatts', cpupowerdraw: 'cpuWatts',
      gpuwatts: 'gpuWatts', gpupower: 'gpuWatts', gpupowerdraw: 'gpuWatts',
      watts: 'cpuWatts', power: 'cpuWatts', powerdraw: 'cpuWatts',
    };
    const key = alias[String(metricArg || '').toLowerCase().replace(/[^a-z]/g, '')];
    if (!key) return { error: 'unknown_metric', validMetrics: ['cpu', 'cpuTemp', 'gpu', 'gpuTemp', 'mem', 'cpuWatts', 'gpuWatts'] };
    const days = state.store.days;
    const dayAgg = (b) => (b ? aggregate([b], key) : null);
    let peak = null;
    for (const b of days.slice(-30)) {
      const a = aggregate([b], key);
      if (a.max != null && (!peak || a.max > peak.max)) peak = { date: b.d, max: a.max };
    }
    return {
      metric: key,
      isTemperature: key.endsWith('Temp'),
      collectedDays: days.length,
      today: days.length ? dayAgg(days[days.length - 1]) : null,
      yesterday: days.length > 1 ? dayAgg(days[days.length - 2]) : null,
      last24h: aggregate(state.store.hours.slice(-24), key),
      last7dAvg: aggregate(days.slice(-7), key).avg,
      last30dAvg: aggregate(days.slice(-30), key).avg,
      peakDay30d: peak,
      dailySeries7d: days.slice(-7).map((b) => ({ date: b.d, ...aggregate([b], key) })),
    };
  }

  // Compact deterministic digest for the AI: averages/maxima over the last
  // 24h / 7d / 30d plus 7d-vs-30d deltas. Computed locally, zero API cost.
  async function getDigest() {
    await load();
    const h24 = state.store.hours.slice(-24);
    const d7 = state.store.days.slice(-7);
    const d30 = state.store.days.slice(-30);
    const windowStats = (buckets) => ({
      cpuLoad: aggregate(buckets, 'cpu'),
      cpuTemp: aggregate(buckets, 'cpuTemp'),
      gpuLoad: aggregate(buckets, 'gpu'),
      gpuTemp: aggregate(buckets, 'gpuTemp'),
      memPercent: aggregate(buckets, 'mem'),
      cpuWatts: aggregate(buckets, 'cpuWatts'),
      gpuWatts: aggregate(buckets, 'gpuWatts'),
    });
    const s7 = windowStats(d7);
    const s30 = windowStats(d30);
    const delta = (a, b) => (a.avg != null && b.avg != null) ? Math.round((a.avg - b.avg) * 10) / 10 : null;
    return {
      collectedDays: state.store.days.length,
      collectedHours: state.store.hours.length,
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

  return { getHistory, getEnergy, getEnergySummary, queryHistory, getDigest };
}

module.exports = { makeAnswers };
