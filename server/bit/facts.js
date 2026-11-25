'use strict';
// The facts of one minute for traits.js, read from what the engine already
// keeps: no reading of its own, no program started. A reading older than
// FRESH_MS is no fact at all (nobody watched the dashboard, so nothing was read),
// which only makes a trait slower to earn, never wrong.

const { sensorCache } = require('../system/sensor-cache.js');
const { sensorReads } = require('../system/sensor-reads-state.js');
const { _idleProbe } = require('../system/idle-seconds.js');
const { mediaNow } = require('../media/now-state.js');
const gameDetect = require('../performance/gamedetect');
const { sseClients } = require('../http/sse-clients.js');

const FRESH_MS = 2 * 60 * 1000;
const HOT_C = 80;
const AWAY_SEC = 5 * 60;

const fresh = (at, now) => Number.isFinite(at) && at > 0 && now - at < FRESH_MS;
const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

/**
 * @param {number} [now] ms
 * @returns {{ gaming: boolean, music: boolean, coding: boolean, hot: boolean, active: boolean, open: boolean }}
 */
function readFacts(now = Date.now()) {
  const cpu = sensorCache.reading;
  const gpu = sensorReads.gpuCache;
  const media = mediaNow.cache;
  const hot = (fresh(cpu.updatedAt, now) && Number(cpu.cpuTemp) >= HOT_C)
    || (fresh(gpu.updatedAt, now) && Number(gpu.gpuTemp) >= HOT_C);
  const idle = fresh(_idleProbe.at, now) ? _idleProbe.sec : null;
  const gaming = safe(() => gameDetect.isGaming(), false);
  return {
    gaming,
    music: fresh(media.updatedAt, now) && !!media.data && media.data.playbackStatus === 'Playing',
    coding: safe(() => gameDetect.getActivity(), 'other') === 'coding',
    hot,
    // Someone at the PC: input in the last minutes, or a game (a pad leaves no
    // input here). Unknown while the input probe is off: a dashboard left on
    // a second screen all night must not make a night owl.
    active: gaming || (idle != null && idle < AWAY_SEC),
    // A dashboard open somewhere: enough to count a day of use.
    open: sseClients.size > 0,
  };
}

module.exports = { readFacts, HOT_C, FRESH_MS };
