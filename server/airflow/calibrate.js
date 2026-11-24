'use strict';
// The fan check: two or three loud minutes, started by the person, that teach
// Airflow each control it may drive. It runs in four steps, five with a beta control:
//   spin   every control at 100 %, until the speeds settle: each fan's top speed;
//   pair   one control at a time lowered to PAIR_DUTY and left there: the speed
//          readings that drop are that control's own (a hub can carry several, a
//          header named "Fan #2" may well read on "Fan #3");
//   sweep  every paired control down the same duty steps together, one speed per
//          step; a fan that stops is set to 0 at the reading that shows it;
//   start  each fan that stopped is asked again from rest, START_STEP higher per
//          try, until it turns: the duty that starts it;
//   back   only the controls Xenon never tried on real hardware: each to full, then
//          let go, the proof that the PC takes it back (calibrate-back.js).
// calibrate-plan.js says what the check moves and for how long, calibrate-settle.js
// when a speed has settled; calibrate-fit.js turns the measurements into what Airflow keeps.
//
// The check only proposes duties. Every tick still goes through the safety layer
// (safety.js) and the hands' own rules, unchanged: heat, a lost sensor or a silent
// engine end it. Their stall rule stays on too: a fan never waits asked to turn
// while reading 0 for longer than START_TRY_MS, which is under STALL_MS.
const Fit = require('./calibrate-fit.js');
const { createSettle, SETTLE } = require('./calibrate-settle.js');
const { createBackStep } = require('./calibrate-back.js');
const { cleanChannels, budgetMs, pointsFor, SWEEP, MAX_MS, SLOW_SETTLE_MAX_MS } = require('./calibrate-plan.js');

// Low enough for every fan to drop clearly, high enough that a 3-pin fan on a
// voltage header (6 V here) keeps turning.
const PAIR_DUTY = 50;
const START_STEP = 5;
// From the change, not from when the hands applied it: the safety layer's stall
// clock starts at the change too.
const START_TRY_MS = 4000;
// At 0 before each try: the next one starts from rest, and the stall clock restarts.
const REST_MS = 2000;
const NO_READING_MS = 10000;
const PHASE_WEIGHT = Object.freeze({ spin: 0, pair: 0.1, sweep: 0.5, start: 0.8, back: 0.9, done: 1 });
const NEXT = Object.freeze({ spin: 'pair', pair: 'sweep', sweep: 'start', start: 'back', back: 'done', done: 'done' });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * @typedef {{ at: number, tachs: Record<string, number|null>, duty?: Record<string, number|null> }} CheckReading
 */

/** @param {{ channels: import('./calibrate-plan.js').CheckChannel[], clock?: () => number }} opts */
function createFanCheck({ channels, clock = Date.now }) {
  const chs = cleanChannels(channels);
  const startedAt = clock();
  const maxMs = budgetMs(chs);
  let phase = 'spin';
  let why = null;
  let result = null;
  /** @type {Record<string, number>} */
  let targets = Object.fromEntries(chs.map((c) => [c.id, 100]));
  const settle = createSettle();
  const limitOf = (ids) => Math.max(SETTLE.maxMs, ...chs.filter((c) => ids.includes(c.id)).map((c) => c.settleMs));
  const spinMs = limitOf(chs.map((c) => c.id));
  settle.change(startedAt, chs.map((c) => c.id), spinMs);
  let lastAt = null;
  let freshAt = startedAt;
  let base = {};
  let prev = {};
  let pairIdx = 0;
  const taken = new Set();
  /** @type {Map<string, string[]>} */
  const claims = new Map();
  const sweeps = new Map();
  const probes = new Map();
  let back = null;

  const slowest = (id, tachs) => {
    const ids = claims.get(id) || [];
    const v = ids.map((t) => tachs?.[t]);
    return ids.length && v.every(isNum) ? Math.min(...v) : null;
  };

  function setTargets(now, pairs) {
    const changed = [];
    for (const [id, duty] of pairs) if (targets[id] !== duty) { targets[id] = duty; changed.push(id); }
    settle.change(now, changed, limitOf(changed));
  }

  const settled = (now, watch) => settle.settled(now, watch);
  const snapshot = (ids) => settle.snapshot(ids);
  const readable = (tachs) => Object.keys(tachs).filter((id) => isNum(tachs[id]));

  function lowerNext(now) {
    if (pairIdx >= chs.length) return beginSweep(now);
    const ch = chs[pairIdx];
    targets[ch.id] = Math.max(PAIR_DUTY, ch.floor);
    settle.change(now, [ch.id], ch.settleMs);
  }

  function pair(now, tachs) {
    const ch = chs[pairIdx];
    // Stopped by the lowering (a weak fan on a voltage header): paired now and put
    // back to full, before the safety layer could call it a stall.
    const stopped = readable(tachs).some((id) => !taken.has(id) && prev[id] > Fit.STOP_RPM && tachs[id] <= Fit.STOP_RPM);
    if (!stopped && !settled(now, readable(tachs))) return;
    const now_ = stopped ? Object.fromEntries(readable(tachs).map((id) => [id, tachs[id]])) : snapshot(readable(tachs));
    claims.set(ch.id, Fit.pairDrops(prev, now_, taken));
    if (stopped) targets[ch.id] = 100;
    prev = now_;
    pairIdx += 1;
    lowerNext(now);
  }

  function beginSweep(now) {
    phase = 'sweep';
    const next = [];
    for (const ch of chs) {
      if (!claims.get(ch.id)?.length) { delete targets[ch.id]; continue; }
      const points = pointsFor(ch);
      sweeps.set(ch.id, { points, idx: 0, samples: [], stoppedAt: null, lowestTurning: null, done: false, seen: false, since: now });
      next.push([ch.id, points[0]]);
    }
    if (!sweeps.size) return beginStart(now);
    setTargets(now, next);
  }

  // Stopped at this step. A pump never rests: one that stops goes straight back to full.
  function stopHere(id, s) {
    s.stoppedAt = s.points[s.idx];
    s.done = true;
    targets[id] = chs.find((c) => c.id === id).kind === 'pump' ? 100 : 0;
  }

  function sweep(now, tachs) {
    for (const [id, s] of sweeps) {
      if (s.done) continue;
      const rpm = slowest(id, tachs);
      if (rpm == null) continue;
      if (rpm > Fit.STOP_RPM) { s.seen = true; continue; }
      // A stop counts once the fan turned at this step (one stopped while pairing
      // is still spinning up); one that never turns gets no longer than a try.
      if (s.seen || now - s.since >= START_TRY_MS) stopHere(id, s);
    }
    const active = [...sweeps].filter(([, s]) => !s.done);
    if (!active.length) return beginStart(now);
    if (!settled(now, active.flatMap(([id]) => claims.get(id)))) return;
    const next = [];
    for (const [id, s] of active) {
      // Neither turning nor stopped for a whole step: its reading is gone. Back to
      // the PC, and nothing kept.
      if (!s.seen) { s.lost = true; s.done = true; delete targets[id]; continue; }
      s.samples.push({ duty: s.points[s.idx], tachs: snapshot(claims.get(id)) });
      s.lowestTurning = s.points[s.idx];
      s.idx += 1;
      if (s.idx >= s.points.length) { s.done = true; continue; }
      s.seen = false;
      s.since = now;
      next.push([id, s.points[s.idx]]);
    }
    if (next.length) setTargets(now, next);
    else beginStart(now);
  }

  function beginStart(now) {
    phase = 'start';
    for (const ch of chs) {
      const s = sweeps.get(ch.id);
      if (!s || s.stoppedAt == null || ch.kind === 'pump') continue;
      const first = Math.max(ch.floor, s.lowestTurning ?? s.stoppedAt + START_STEP);
      probes.set(ch.id, { duty: first, since: now, resting: true, startDuty: null, done: false });
      targets[ch.id] = 0;
    }
    if (!probes.size) beginBack(now);
  }

  function start(now, tachs) {
    for (const [id, p] of probes) {
      if (p.done) continue;
      const rpm = slowest(id, tachs);
      if (p.resting) {
        if (now - p.since >= REST_MS) { p.resting = false; p.since = now; targets[id] = p.duty; }
        continue;
      }
      if (rpm != null && rpm > Fit.STOP_RPM) { p.startDuty = p.duty; p.done = true; continue; }
      if (now - p.since < START_TRY_MS) continue;
      p.duty += START_STEP;
      // Not even full power starts it: back to the PC, and the person is told.
      if (p.duty > 100) { p.done = true; delete targets[id]; continue; }
      p.resting = true;
      p.since = now;
      targets[id] = 0;
    }
    if ([...probes.values()].every((p) => p.done)) beginBack(now);
  }

  function beginBack(now) {
    const ids = chs.filter((c) => c.beta && claims.get(c.id)?.length).map((c) => c.id);
    if (!ids.length) return finish(null);
    phase = 'back';
    back = createBackStep({ ids, waitMs: limitOf(ids) });
    targets = {};
    setTargets(now, Object.entries(back.targets()));
  }

  function backStep(now, tachs) {
    const speeds = Object.fromEntries(back.ids.map((id) => [id, slowest(id, tachs)]));
    if (back.down) { if (back.watch(now, speeds)) finish(null); return; }
    if (!settled(now, back.ids.flatMap((id) => claims.get(id)))) return;
    back.letGo(now, speeds);
    targets = back.targets();
  }

  function finish(reason) {
    phase = 'done';
    why = reason;
    targets = {};
    if (reason) return;
    const calibs = {};
    const problems = {};
    const at = clock();
    for (const ch of chs) {
      const pairedElsewhere = new Set(chs.filter((c) => c.id !== ch.id).flatMap((c) => claims.get(c.id) || []));
      const r = Fit.fitChannel({
        ch, base, claimed: claims.get(ch.id) || [], pairedElsewhere, at,
        sweep: sweeps.get(ch.id) || { samples: [], stoppedAt: null, lowestTurning: null },
        startDuty: probes.get(ch.id)?.startDuty ?? null,
      });
      // A beta control that never showed it goes back keeps its measure, never driven.
      if (r.calib && ch.beta) { r.calib.handBack = back?.proven(ch.id) === true; if (!r.calib.handBack && !r.problem) r.problem = 'no-handback'; }
      if (r.calib) calibs[ch.id] = r.calib;
      if (r.problem) problems[ch.id] = r.problem;
    }
    result = { calibs, problems };
  }

  function progress(now) {
    let within = 0;
    if (phase === 'pair') within = pairIdx / Math.max(1, chs.length);
    if (phase === 'sweep') within = Math.max(0, ...[...sweeps.values()].map((s) => s.idx)) / SWEEP.length;
    if (phase === 'start') within = [...probes.values()].filter((p) => p.done).length / Math.max(1, probes.size);
    if (phase === 'spin') within = Math.min(1, (now - startedAt) / spinMs);
    if (phase === 'back') within = back.progress();
    const next = NEXT[phase];
    const w = PHASE_WEIGHT[phase] + (PHASE_WEIGHT[next] - PHASE_WEIGHT[phase]) * within;
    return Math.round(w * 100) / 100;
  }

  const view = (now) => ({ phase, progress: progress(now), targets: { ...targets }, done: phase === 'done', why, result });

  /** One tick: the latest reading in, the duties to ask for out. @param {CheckReading|null} reading */
  function step(reading) {
    const now = clock();
    if (phase === 'done') return view(now);
    if (now - startedAt > maxMs) { finish('timeout'); return view(now); }
    const fresh = reading && isNum(reading.at) && reading.at !== lastAt && reading.tachs && typeof reading.tachs === 'object';
    if (!fresh) {
      if (now - freshAt > NO_READING_MS) finish('no-reading');
      return view(now);
    }
    lastAt = reading.at;
    freshAt = now;
    settle.record(now, reading, targets);
    if (phase === 'spin' && settled(now, readable(reading.tachs))) {
      base = snapshot(readable(reading.tachs));
      prev = base;
      phase = 'pair';
      lowerNext(now);
    } else if (phase === 'pair') pair(now, reading.tachs);
    else if (phase === 'sweep') sweep(now, reading.tachs);
    else if (phase === 'start') start(now, reading.tachs);
    else if (phase === 'back') backStep(now, reading.tachs);
    return view(now);
  }

  /**
   * The channels as the safety layer sees them during the check: a fan may rest at 0
   * (the check asks for it), a pump never; the stall rule watches the readings the
   * check has paired, the only ones it can trust yet.
   * @param {CheckReading|null} reading
   */
  function safetyChannels(reading) {
    return chs.filter((c) => c.id in targets).map((c) => {
      const rpm = slowest(c.id, reading?.tachs);
      return { id: c.id, kind: c.kind, rpm, hasTach: rpm != null, minDuty: 0, zeroOk: c.kind !== 'pump', deps: [] };
    });
  }

  return {
    step,
    safetyChannels,
    /** Ends the check without keeping anything (the person, heat, a lost sensor). */
    cancel(reason = 'cancel') { if (phase !== 'done') finish(String(reason)); return view(clock()); },
    view: () => view(clock()),
  };
}

module.exports = { createFanCheck, SWEEP, PAIR_DUTY, SETTLE, START_STEP, START_TRY_MS, MAX_MS, NO_READING_MS, SLOW_SETTLE_MAX_MS };
