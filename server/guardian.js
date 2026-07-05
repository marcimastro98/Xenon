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
const { writeFileAtomic } = require('./atomic-write');

const SAMPLE_MS = 5 * 60 * 1000; // one sensor sample every 5 minutes
const MAX_HOURS = 72;            // keep 3 days of hourly buckets
const MAX_DAYS = 90;             // keep ~3 months of daily rollups

// Foreground-app usage ("PC Screen Time"). We poll the focused app far more
// often than the 5-min sensor tick so short sessions are counted, but accumulate
// purely in memory and let the 5-min sample() flush it to disk — no extra writes.
const USAGE_MS = 15 * 1000;            // sample the foreground app every 15s…
const USAGE_MAX_DELTA_MS = 45 * 1000;  // …but never credit a gap this large (sleep/timer throttle)
const MAX_APPS_PER_DAY = 40;           // cap distinct apps stored per day (bounds the store)
const IDLE_PROC_RE = /^(lockapp|logonui)$/i; // lock/logon screen is "away", not use

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

function createGuardian({ dataDir, getSystemInfo, isEnabled, onAlert, getForegroundApp = () => '', isForegroundGame = () => false }) {
  const FILE = path.join(dataDir, 'guardian.json');
  let store = null; // { hours: [{h, m}], days: [{d, m}], apps: [{d, a}] }
  let timer = null;
  let usageTimer = null;
  let sampling = false;
  const lastAlertAt = { cpu: 0, gpu: 0, mem: 0 };
  // Foreground-usage accumulator: credit each interval to the app that owned the
  // foreground during it (attributed on the NEXT tick, once the interval elapsed).
  let lastUsageAt = 0;
  let lastApp = '';
  let lastAppGame = false;
  // True when the in-memory store gained data since the last flush — sensors
  // being unavailable AND no foreground usage means there is nothing new to
  // write, so the 5-min tick can skip the disk entirely on an idle machine.
  let usageDirty = false;

  function normalizeStore(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
      hours: Array.isArray(src.hours) ? src.hours.slice(-MAX_HOURS) : [],
      days: Array.isArray(src.days) ? src.days.slice(-MAX_DAYS) : [],
      apps: normalizeApps(src.apps),
    };
  }

  // Usage buckets are persisted data → rebuild from the known shape only (never
  // trust arbitrary keys/values), the same boundary discipline as the sensors.
  function normalizeApps(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const b of raw.slice(-MAX_DAYS)) {
      if (!b || typeof b !== 'object' || typeof b.d !== 'string' || !b.a || typeof b.a !== 'object') continue;
      const a = {};
      for (const name of Object.keys(b.a)) {
        const e = b.a[name];
        const s = e && typeof e.s === 'number' && Number.isFinite(e.s) && e.s > 0 ? e.s : 0;
        if (!s) continue;
        a[name] = { s, g: e && e.g ? 1 : 0 };
      }
      out.push({ d: b.d, a });
    }
    return out;
  }

  async function load() {
    if (store) return store;
    try {
      store = normalizeStore(JSON.parse(await fs.promises.readFile(FILE, 'utf8')));
    } catch {
      store = { hours: [], days: [], apps: [] };
    }
    return store;
  }

  // Atomic write (shared primitive): a crash mid-write must never truncate
  // the history store into a corrupt file that load() would reset to empty,
  // discarding weeks of collected data (the durable-store invariant).
  // Returns whether the write reached the disk so callers can retry later.
  async function persist() {
    if (!store) return false;
    try { await writeFileAtomic(FILE, JSON.stringify(store)); return true; }
    catch (e) { console.error('Guardian persist failed:', e.message); return false; }
  }

  function bucketFor(list, keyName, key) {
    let b = list.length ? list[list.length - 1] : null;
    if (!b || b[keyName] !== key) {
      b = { [keyName]: key, m: emptyMetrics() };
      list.push(b);
    }
    return b;
  }

  // Credit `seconds` of foreground time to `app` in the day bucket for `date`.
  function creditUsage(date, app, game, seconds) {
    const key = localKey(date, false);
    let b = store.apps.length ? store.apps[store.apps.length - 1] : null;
    if (!b || b.d !== key) {
      b = { d: key, a: {} };
      store.apps.push(b);
      if (store.apps.length > MAX_DAYS) store.apps = store.apps.slice(-MAX_DAYS);
    }
    const e = b.a[app] || (b.a[app] = { s: 0, g: 0 });
    e.s += seconds;
    if (game) e.g = 1;
    usageDirty = true;
    pruneApps(b);
  }

  // Keep each day bounded to its busiest apps so a long tail of one-off processes
  // can't grow the store without limit.
  function pruneApps(bucket) {
    const names = Object.keys(bucket.a);
    if (names.length <= MAX_APPS_PER_DAY) return;
    names.sort((x, y) => bucket.a[y].s - bucket.a[x].s);
    for (const n of names.slice(MAX_APPS_PER_DAY)) delete bucket.a[n];
  }

  // Attribute the elapsed interval to whatever app was focused during it, so
  // short sessions are counted (a 5-min sensor tick alone would miss them). Zero
  // I/O — mutates the in-memory store; the 5-min sample() flushes it atomically.
  function usageTick() {
    if (!isEnabled() || !store) { lastUsageAt = 0; lastApp = ''; return; }
    const now = Date.now();
    if (lastApp && lastUsageAt) {
      const delta = now - lastUsageAt;
      // A gap larger than a few intervals means the machine slept or the timer
      // was throttled — don't credit those hours to the last-focused app.
      if (delta > 0 && delta <= USAGE_MAX_DELTA_MS) {
        creditUsage(new Date(lastUsageAt), lastApp, lastAppGame, delta / 1000);
      }
    }
    let app = '';
    try { app = String(getForegroundApp() || '').trim().toLowerCase().replace(/\.exe$/, ''); } catch { app = ''; }
    if (IDLE_PROC_RE.test(app)) app = ''; // locked/away → next interval credits nothing
    let game = false;
    try { game = !!isForegroundGame(); } catch { game = false; }
    lastApp = app;
    lastAppGame = game;
    lastUsageAt = now;
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
      // Skip the disk write when this tick recorded nothing new (sensors
      // unavailable and no foreground usage accumulated) — an idle machine
      // shouldn't be written to every 5 minutes for empty buckets. The dirty
      // flag is cleared only AFTER a successful write, so a transient disk
      // failure retries on the next tick instead of stranding data in RAM.
      if (METRICS.some((k) => reading[k] != null)) usageDirty = true;
      if (usageDirty && await persist()) usageDirty = false;
      maybeAlert('cpu', reading.cpuTemp, ALERT_CPU_TEMP);
      maybeAlert('gpu', reading.gpuTemp, ALERT_GPU_TEMP);
      maybeAlert('mem', reading.mem, ALERT_MEM_PCT);
    } catch (e) {
      console.error('Guardian sample failed:', e.message);
    } finally {
      sampling = false;
    }
  }

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
    const buckets = store.apps.slice(-dayCount);
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
      collectedHours: store.hours.length,
      collectedDays: store.days.length,
      sampleMinutes: SAMPLE_MS / 60000,
      hours: series(store.hours, 'h'),
      days: series(store.days, 'd'),
      usage: {
        // Ranges mirror the chart switcher; app buckets are daily, so 24h ≈ today.
        ranges: { '24h': appsInRange(1), '7d': appsInRange(7), '30d': appsInRange(30) },
      },
    };
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
    };
    const key = alias[String(metricArg || '').toLowerCase().replace(/[^a-z]/g, '')];
    if (!key) return { error: 'unknown_metric', validMetrics: ['cpu', 'cpuTemp', 'gpu', 'gpuTemp', 'mem'] };
    const days = store.days;
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
      last24h: aggregate(store.hours.slice(-24), key),
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
    load(); // populate the store so the usage ticker can accumulate immediately
    timer = setInterval(() => {
      if (!isEnabled()) return; // disabled → just a boolean check, zero cost
      sample();
    }, SAMPLE_MS);
    timer.unref();
    // Foreground-app usage: cheap in-memory accumulation; flushed by sample().
    usageTimer = setInterval(usageTick, USAGE_MS);
    usageTimer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (usageTimer) { clearInterval(usageTimer); usageTimer = null; }
  }

  // Backup bridge: the whole history store, already in its normalized shape.
  async function exportStore() {
    await load();
    return store;
  }

  // Wholesale replace from a backup bundle — same boundary normalization as
  // load(), then an immediate atomic flush. Unlike the sampler's best-effort
  // persist(), a failed write here THROWS so the backup import can honestly
  // report the section as failed instead of "restored" into RAM only.
  async function importStore(raw) {
    store = normalizeStore(raw);
    usageDirty = false;
    await writeFileAtomic(FILE, JSON.stringify(store));
    return { ok: true, hours: store.hours.length, days: store.days.length };
  }

  return { start, stop, sample, getDigest, getHistory, queryHistory, exportStore, importStore };
}

module.exports = { createGuardian };
