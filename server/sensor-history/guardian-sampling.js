'use strict';
// What the sensor history counts: a reading into its hour and day, the seconds of the app in
// front, and a warning when something runs hot.

const Recent = require('./recent.js');
const Energy = require('./energy.js');
const {
  DUE_SLACK_MS, PERSIST_MS, MAX_HOURS, MAX_DAYS, USAGE_MAX_DELTA_MS, MAX_APPS_PER_DAY, IDLE_PROC_RE,
  ALERT_CPU_TEMP, ALERT_GPU_TEMP, ALERT_MEM_PCT, ALERT_COOLDOWN_MS,
} = require('./guardian-limits.js');
const { METRICS, emptyMetrics, addMetric, localKey } = require('./guardian-metrics.js');

function makeSampling({
  getSystemInfo, isEnabled, onAlert, getForegroundApp, isForegroundGame, state, everyMin,
  lastAlertAt, load, persist,
}) {
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
    let b = state.store.apps.length ? state.store.apps[state.store.apps.length - 1] : null;
    if (!b || b.d !== key) {
      b = { d: key, a: {} };
      state.store.apps.push(b);
      if (state.store.apps.length > MAX_DAYS) state.store.apps = state.store.apps.slice(-MAX_DAYS);
    }
    const e = b.a[app] || (b.a[app] = { s: 0, g: 0 });
    e.s += seconds;
    if (game) e.g = 1;
    state.usageDirty = true;
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
  // short sessions are counted (the sensor sample alone would miss them). Zero
  // I/O — mutates the in-memory store; sample() flushes it atomically.
  function usageTick() {
    if (!isEnabled() || !state.store) { state.lastUsageAt = 0; state.lastApp = ''; return; }
    const now = Date.now();
    if (state.lastApp && state.lastUsageAt) {
      const delta = now - state.lastUsageAt;
      // A gap larger than a few intervals means the machine slept or the timer
      // was throttled — don't credit those hours to the last-focused app.
      if (delta > 0 && delta <= USAGE_MAX_DELTA_MS) {
        creditUsage(new Date(state.lastUsageAt), state.lastApp, state.lastAppGame, delta / 1000);
      }
    }
    let app = '';
    try { app = String(getForegroundApp() || '').trim().toLowerCase().replace(/\.exe$/, ''); } catch { app = ''; }
    if (IDLE_PROC_RE.test(app)) app = ''; // locked/away → next interval credits nothing
    let game = false;
    try { game = !!isForegroundGame(); } catch { game = false; }
    state.lastApp = app;
    state.lastAppGame = game;
    state.lastUsageAt = now;
  }

  function maybeAlert(type, value, threshold) {
    if (typeof value !== 'number' || value < threshold) return;
    const now = Date.now();
    if (now - lastAlertAt[type] < ALERT_COOLDOWN_MS) return;
    lastAlertAt[type] = now;
    try { onAlert({ type, value: Math.round(value) }); } catch { /* alert is best-effort */ }
  }

  async function sample() {
    if (state.sampling) return;
    state.sampling = true;
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
        cpuWatts: sys.power && typeof sys.power.cpu === 'number' ? sys.power.cpu : null,
        gpuWatts: sys.power && typeof sys.power.gpu === 'number' ? sys.power.gpu : null,
      };
      const hour = bucketFor(state.store.hours, 'h', localKey(now, true));
      const day = bucketFor(state.store.days, 'd', localKey(now, false));
      // Watt-hours for the kWh views (sensor-history/energy.js).
      const draw = { cpu: reading.cpuWatts, gpu: reading.gpuWatts, psu: sys.power && sys.power.psu };
      const ms = Energy.creditMs(state.lastCreditAt, now.getTime(), everyMin() * 60 * 1000);
      if (Energy.credit(hour, draw, ms) && Energy.credit(day, draw, ms)) state.usageDirty = true;
      state.lastCreditAt = now.getTime();
      state.lastDraw = { ...Energy.drawOf(draw), at: now.toISOString() };
      for (const k of METRICS) {
        // Buckets persisted before a metric existed lack its slot — backfill so
        // the first post-upgrade sample can't throw on `slot.min`.
        if (!hour.m[k]) hour.m[k] = { min: null, max: null, sum: 0, n: 0 };
        if (!day.m[k]) day.m[k] = { min: null, max: null, sum: 0, n: 0 };
        addMetric(hour.m[k], reading[k]);
        addMetric(day.m[k], reading[k]);
      }
      if (state.store.hours.length > MAX_HOURS) state.store.hours = state.store.hours.slice(-MAX_HOURS);
      if (state.store.days.length > MAX_DAYS) state.store.days = state.store.days.slice(-MAX_DAYS);
      const got = METRICS.some((k) => reading[k] != null);
      if (got) state.store.recent = Recent.pushRecent(state.store.recent, reading, METRICS, now.getTime());
      // Skip the disk write when this tick recorded nothing new (sensors
      // unavailable and no foreground usage accumulated) — an idle machine
      // shouldn't be written to for empty buckets — and write at most every
      // PERSIST_MS. The dirty flag is cleared only AFTER a successful write, so
      // a transient disk failure retries on the next sample instead of
      // stranding data in RAM.
      if (got) state.usageDirty = true;
      if (state.usageDirty && now.getTime() - state.lastPersistAt >= PERSIST_MS - DUE_SLACK_MS && await persist()) {
        state.usageDirty = false;
        state.lastPersistAt = now.getTime();
      }
      maybeAlert('cpu', reading.cpuTemp, ALERT_CPU_TEMP);
      maybeAlert('gpu', reading.gpuTemp, ALERT_GPU_TEMP);
      maybeAlert('mem', reading.mem, ALERT_MEM_PCT);
    } catch (e) {
      console.error('Guardian sample failed:', e.message);
    } finally {
      state.sampling = false;
    }
  }

  return { usageTick, sample };
}

module.exports = { makeSampling };
