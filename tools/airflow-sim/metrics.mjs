// What a run is judged on, the same way for every controller:
//   maxDie       hottest each component got
//   overTarget   seconds a die spent more than 1 C over its balanced target
//   meanDb/p95Db estimated loudness of all fans together (brain-noise.js laws,
//                applied to the RPM the fans really turned at)
//   changes      audible changes: the total level moving 1 dB or more within 2 s
//   reversals    a fan turning back after moving 3 % of its range one way
//   fullSeconds  seconds every fan was forced to 100 % by the safety layer
//   reactedIn    seconds from an injected fault to the safety layer's answer
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../server/airflow/limits.js');
const N = require('../../server/airflow/brain-noise.js');

const OVER_BY = 1;
const AUDIBLE_DB = 1;
const AUDIBLE_SPAN_S = 2;
const REVERSE_SHARE = 0.03;

export function createMetrics({ channels, cpuName, fault = null }) {
  const targets = Object.fromEntries(['cpu', 'gpu', 'gpuMem'].map((n) => [n, L.targetFor(n, L.MODES.balanced, cpuName)]));
  const maxDie = { cpu: -Infinity, gpu: -Infinity, gpuMem: -Infinity };
  const overTarget = { cpu: 0, gpu: 0, gpuMem: 0 };
  const levels = [];
  const trend = new Map();
  let changes = 0;
  let changing = false;
  let reversals = 0;
  let fullSeconds = 0;
  let reactedIn = null;

  // ref is the furthest point of the current move; a move the other way of more
  // than REVERSE_SHARE of the range is a reversal.
  function reverse(ch, rpm) {
    const t = trend.get(ch.id) || { ref: rpm, dir: 0 };
    const step = REVERSE_SHARE * ch.maxRpm;
    const turn = (dir) => { if (t.dir !== 0) reversals += 1; t.dir = dir; t.ref = rpm; };
    if (t.dir >= 0 && rpm > t.ref) { if (t.dir === 0 && rpm > t.ref + step) turn(1); else if (t.dir === 1) t.ref = rpm; }
    if (t.dir <= 0 && rpm < t.ref) { if (t.dir === 0 && rpm < t.ref - step) turn(-1); else if (t.dir === -1) t.ref = rpm; }
    if (t.dir === 1 && rpm < t.ref - step) turn(-1);
    else if (t.dir === -1 && rpm > t.ref + step) turn(1);
    trend.set(ch.id, t);
  }

  function reacted(t, verdict) {
    if (!fault || reactedIn != null || t < fault.at || !verdict) return;
    const hit = (id) => verdict.channels[id]?.action === 'firmware';
    const ids = fault.channel ? [fault.channel]
      : fault.component === 'brain' ? channels.map((c) => c.id)
        : channels.filter((c) => (c.deps || []).includes(fault.component)).map((c) => c.id);
    if (ids.length && ids.every(hit)) reactedIn = t - fault.at;
  }

  /** One second of the run: true die temperatures, RPMs, and the safety verdict if any. */
  function add(t, dies, rpm, verdict) {
    for (const n of Object.keys(maxDie)) {
      maxDie[n] = Math.max(maxDie[n], dies[n]);
      if (dies[n] > targets[n] + OVER_BY) overTarget[n] += 1;
    }
    const level = N.totalDb(channels.map((c) => N.fanDb(c, rpm[c.id])));
    levels.push(level);
    const back = levels[levels.length - 1 - AUDIBLE_SPAN_S];
    const moving = back != null && Math.abs(level - back) >= AUDIBLE_DB;
    if (moving && !changing) changes += 1;
    changing = moving;
    for (const c of channels) reverse(c, rpm[c.id]);
    if (verdict?.mode === 'full') fullSeconds += 1;
    reacted(t, verdict);
  }

  function result() {
    const finite = levels.filter(Number.isFinite).sort((a, b) => a - b);
    const mean = finite.reduce((s, x) => s + x, 0) / Math.max(1, finite.length);
    const round = (x) => Math.round(x * 10) / 10;
    return {
      maxDie: Object.fromEntries(Object.entries(maxDie).map(([k, v]) => [k, round(v)])),
      overTarget,
      meanDb: round(mean),
      p95Db: round(finite[Math.floor(finite.length * 0.95)] ?? 0),
      changes,
      reversals,
      fullSeconds,
      reactedIn,
    };
  }

  return { add, result, targets };
}
