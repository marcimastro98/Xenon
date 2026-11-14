'use strict';

// ── Guardian — long-term hardware health history (opt-in) ───────────────────
// While enabled (Settings → Funzioni AI → Guardian), samples the system
// sensors every few minutes and aggregates them into hourly buckets and daily
// rollups persisted in data/guardian.json. Collection is fully local and free;
// the AI analysis happens only when the user asks Xenon (guardian_report tool).
// While the feature is OFF the tick is a single boolean check — no sensors
// are read and nothing is written.

const path = require('path');

const { normalizeEveryMin } = require('./js/sensor-history.js');

const { TICK_MS, DUE_SLACK_MS, USAGE_MS } = require('./sensor-history/guardian-limits.js');

const { makeStore } = require('./sensor-history/guardian-store.js');

const { makeSampling } = require('./sensor-history/guardian-sampling.js');

const { makeAnswers } = require('./sensor-history/guardian-answers.js');

function createGuardian({ dataDir, getSystemInfo, isEnabled, onAlert, getForegroundApp = () => '', isForegroundGame = () => false, getEveryMin = () => 5 }) {
  const FILE = path.join(dataDir, 'guardian.json');
  const state = {
    store: null, // { hours: [{h, m}], days: [{d, m}], apps: [{d, a}], recent: [{at, v}] }
    timer: null,
    usageTimer: null,
    sampling: false,
    lastSampleAt: 0,
    lastPersistAt: 0,
    lastCreditAt: 0, // the previous reading, for how long the next one stands for
    lastDraw: null,  // the last reading's watts, for the energy stream
    // Foreground-usage accumulator: credit each interval to the app that owned the
    // foreground during it (attributed on the NEXT tick, once the interval elapsed).
    lastUsageAt: 0,
    lastApp: '',
    lastAppGame: false,
    // True when the in-memory store gained data since the last flush — sensors
    // being unavailable AND no foreground usage means there is nothing new to
    // write, so the sample can skip the disk entirely on an idle machine.
    usageDirty: false,
  };

  function everyMin() {
    try { return normalizeEveryMin(getEveryMin()); } catch { return normalizeEveryMin(null); }
  }
  const lastAlertAt = { cpu: 0, gpu: 0, mem: 0 };

  const { load, persist, exportStore, importStore } = makeStore({ FILE, state });

  const {
    usageTick, sample,
  } = makeSampling({ getSystemInfo, isEnabled, onAlert, getForegroundApp, isForegroundGame, state, everyMin, lastAlertAt, load, persist });

  const {
    getHistory, getEnergy, getEnergySummary, queryHistory, getDigest,
  } = makeAnswers({ isEnabled, state, everyMin, load });

  function start() {
    if (state.timer) return;
    load(); // populate the store so the usage ticker can accumulate immediately
    state.timer = setInterval(() => {
      if (!isEnabled()) return; // disabled → just a boolean check, zero cost
      const now = Date.now();
      if (now - state.lastSampleAt < everyMin() * 60 * 1000 - DUE_SLACK_MS) return;
      state.lastSampleAt = now;
      sample();
    }, TICK_MS);
    state.timer.unref();
    // Foreground-app usage: cheap in-memory accumulation; flushed by sample().
    state.usageTimer = setInterval(usageTick, USAGE_MS);
    state.usageTimer.unref();
  }

  function stop() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (state.usageTimer) { clearInterval(state.usageTimer); state.usageTimer = null; }
  }

  return { start, stop, sample, getDigest, getHistory, getEnergy, getEnergySummary, queryHistory, exportStore, importStore };
}

module.exports = { createGuardian };
