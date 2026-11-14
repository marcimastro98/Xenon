'use strict';
// How often the sensor history samples and writes, how much it keeps, and when it warns.

// How often a sample is taken is the user's choice (sensorHistory.everyMin,
// 1 to 15 minutes, default 5). One timer ticks every minute and samples when
// the chosen interval has passed, so a change applies without restarting it.
const TICK_MS = 60 * 1000;
const DUE_SLACK_MS = 5 * 1000;   // a tick that fires a little early still counts
// The disk is written at most this often whatever the interval, so a 1-minute
// interval costs memory, not five times the writes.
const PERSIST_MS = 5 * 60 * 1000;
const MAX_HOURS = 72;            // keep 3 days of hourly buckets
const MAX_DAYS = 90;             // keep ~3 months of daily rollups

// Foreground-app usage ("PC Screen Time"). We poll the focused app far more
// often than the sensor sample so short sessions are counted, but accumulate
// purely in memory and let sample() flush it to disk — no extra writes.
const USAGE_MS = 15 * 1000;            // sample the foreground app every 15s…
const USAGE_MAX_DELTA_MS = 45 * 1000;  // …but never credit a gap this large (sleep/timer throttle)
const MAX_APPS_PER_DAY = 40;           // cap distinct apps stored per day (bounds the store)
const IDLE_PROC_RE = /^(lockapp|logonui)$/i; // lock/logon screen is "away", not use

// Alert thresholds (°C / % RAM) with a cooldown so toasts don't spam.
const ALERT_CPU_TEMP = 90;
const ALERT_GPU_TEMP = 88;
const ALERT_MEM_PCT = 95;
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

module.exports = {
  TICK_MS, DUE_SLACK_MS, PERSIST_MS, MAX_HOURS, MAX_DAYS, USAGE_MS, USAGE_MAX_DELTA_MS,
  MAX_APPS_PER_DAY, IDLE_PROC_RE, ALERT_CPU_TEMP, ALERT_GPU_TEMP, ALERT_MEM_PCT, ALERT_COOLDOWN_MS,
};
