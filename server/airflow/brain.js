'use strict';
// The brain, one tick at a time: readings in, fan duties and reasons out.
// It owns the thermal models (brain-model.js), the context (brain-context.js),
// the planner (brain-plan.js) and the smoother (brain-smooth.js), and adds two
// things none of them can see alone:
//   - integral correction: if a component sits above its target for a while
//     although the plan says it should not, the model is wrong somewhere, and the
//     air asked for that component grows until the die obeys (brain-correct.js);
//   - the pump, held on the liquid (real or estimated), not on the die.
// Safety is NOT here: safety.js checks every value this returns.
const L = require('./limits.js');
const { createNodeModel } = require('./brain-model.js');
const { createAir, createLow } = require('./brain-air.js');
const { lastOf, resumeOf } = require('./brain-resume.js');
const { createContext } = require('./brain-context.js');
const { plan: makePlan, groupsOf } = require('./brain-plan.js');
const { createCorrection } = require('./brain-correct.js');
const { createSmoother } = require('./brain-smooth.js');
const R = require('./reasons.js');

const DIE_SMOOTH_MS = 10000;
const OFFSET_SMOOTH_MS = 60000;
const POWER_FRESH_MS = 10000;
// The pump speeds up as the liquid warms past its idle (the lowest lately, never under 30 C, kept across restarts: brain-air.js)
// or past the warmth over the air the slider lets it hold (limits.js liquidRiseFor), the higher, at the latest `span` degrees under its
// ceiling: at 88 % on a warm case's 37 C idle it was the loudest thing in the PC, and held to the idle it climbed for warmth kept on purpose.
const PUMP = Object.freeze({ low: 0.6, from: 30, span: 4 });
const SPIKE_TICKS = 6;
const PREDICT_S = 60;
// Right after Xenon takes the fans it holds the speeds they already turn at while
// the averages fill, so a burst in the first second does not ramp them up.
const WARMUP_MS = 10000;
// Until each model has once seen this PC sit still (brain-model.js), it plans from
// priors that may not fit it at all: a cooler another app runs looks like no cooler.
// Until then, while every component sits LEARN_MARGIN under its target, draws no
// more than it did at rest (LEARN_POWER_X times the lowest half-minute power seen,
// and at least LEARN_POWER_W over it) and its die's half-minute average did not climb LEARN_RISE over the last LEARN_RISE_MS (a game
// already running when Xenon took the fans), the fans may then slow down but not
// speed up: a guessed plan lowered a fan and then raised it back on an idle PC, a
// change heard for nothing. The hold has no time limit: one that ran out after 8
// minutes let a fit from a load run a case fan louder than the board did on an idle
// PC (22 Nov 2026), and a PC that is never still stays where its board had it.
// Lowering is allowed and work ends the hold on purpose: fans held still leave the
// model nothing to learn from, and a card that warmed with its fans held cost
// degrees for the rest of a game. Work is read on the power and on the die's slow
// average, never on the slow node: with R not yet learned a few seconds of burst
// swing the slow node by degrees, and each swing let a guessed plan run the fans at
// full speed on an idle PC.
const LEARN_MARGIN = 8;
const LEARN_POWER_X = 1.5;
const LEARN_POWER_W = 25;
const LEARN_RISE = 6;
const LEARN_RISE_MS = 60000;
const DIE_SLOW_MS = 30000;
// "Out of reach" is said of a component only once it sits within this of its
// target: under it, the model's fear is not news (a CPU on its own cooler, 2
// degrees under, was called that while the priors still ruled).
const REACH_NEAR = 1;

const ema = (prev, x, dt, tau) => (prev == null ? x : prev + (x - prev) * (1 - Math.exp(-dt / tau)));
const val = (r) => (r && Number.isFinite(r.value) ? r.value : null);

/**
 * @param {{ channels: any[], cpuName?: string, memory?: any, saved?: any, last?: any }} opts
 *   last: what the last brain's last() answered (brain-resume.js), for a restart of seconds
 */
function createBrain({ channels, cpuName = '', memory = {}, saved = {}, last = null }) {
  const fans = channels.filter((c) => c.kind !== 'pump');
  const models = {
    cpu: createNodeModel({ node: 'cpu', channels: fans.map((c) => ({ id: c.id, place: c.place || 'case' })) }),
    gpu: createNodeModel({ node: 'gpu', channels: fans.map((c) => ({ id: c.id, place: c.place || 'case' })) }),
  };
  for (const [k, m] of Object.entries(models)) if (saved?.[k]) m.load(saved[k]);
  const context = createContext({ memory });
  const smoother = createSmoother();
  const hasRadiator = channels.some((c) => c.place === 'radiator') || channels.some((c) => c.kind === 'pump');
  const beats = groupsOf(channels.filter((c) => c.controllable && c.kind !== 'pump')).filter((g) => g.length > 1);

  // Where each fan is taken from. A beat group turns as one at its fastest member's speed
  // (brain-smooth.js), so it is taken at its slowest turning fan, and only once every fan in
  // it has been read: while the engine restarted the BIOS ran a case fan of the radiator's
  // kind at 95 %, and the group pulled the radiator up to it for a minute (23 Nov 2026). A fan
  // standing still (stalled, or resting) neither stops the ones that turn nor is started by them.
  function startSpeeds(measured) {
    const out = { ...measured };
    for (const g of beats) {
      const seen = g.map((id) => measured[id]);
      if (!seen.every(Number.isFinite)) { for (const id of g) delete out[id]; continue; }
      const turning = seen.filter((f) => f > 0);
      if (!turning.length) continue;
      const low = Math.min(...turning);
      for (const id of g) if (measured[id] > 0) out[id] = low;
    }
    return out;
  }
  const air = createAir(saved?.air);
  const liquidLow = createLow(saved?.pumpLow);
  const correction = createCorrection({ models, smoothMs: DIE_SMOOTH_MS });
  const st = { at: 0, startedAt: null, resume: null, driving: false, plan: null, tookAt: null, out: null, dieSmooth: {}, dieSlow: {}, dieSeen: {}, restP: {}, offset: {}, powerAt: {}, dies: [], slows: [] };

  // A fan with a tach is measured by its tach alone: before its first reading its duty is
  // only what was last written, and a hub just taken reports the full speed it was told
  // a second ago. Read as measured, that held every fan at full for a minute after each
  // restart (23 Nov 2026).
  function measuredFractions(snap) {
    const out = {};
    for (const c of channels) {
      const rpm = snap.rpm?.[c.id];
      if (c.hasTach && c.maxRpm > 0) { if (Number.isFinite(rpm)) out[c.id] = Math.min(1, rpm / c.maxRpm); }
      else if (Number.isFinite(snap.duty?.[c.id])) out[c.id] = snap.duty[c.id] / 100;
    }
    return out;
  }

  // untrusted: components the safety layer stopped believing; the brain ignores
  // them too, so a frozen reading never feeds the model or the plan.
  function observe(snap, dt, untrusted) {
    const fr = measuredFractions(snap);
    const slows = ['cpu', 'gpu'].filter((n) => !untrusted.has(n)).map((n) => models[n].state().S);
    const liquid = val(snap.temps?.liquid) != null && !untrusted.has('cpu');
    const a = air.update({ now: snap.at, dt, board: val(snap.temps?.board), slows, liquid });
    const readings = { ambient: a.smooth, liquidTarget: hasRadiator };
    for (const node of ['cpu', 'gpu']) {
      const die = val(snap.temps?.[node]);
      const power = snap.power?.[node];
      if (Number.isFinite(power) && power > 0) st.powerAt[node] = snap.at;
      if (die == null || untrusted.has(node)) continue;
      models[node].observe({ at: snap.at, die, power: Number.isFinite(power) ? power : null, ambient: a.now, fractions: fr, liquid: node === 'cpu' ? val(snap.temps?.liquid) : null });
      st.dieSmooth[node] = ema(st.dieSmooth[node], die, dt, DIE_SMOOTH_MS);
      // A plain mean until it is half a minute old: one first reading slowly
      // forgotten would read as a climb.
      st.dieSlow[node] = ema(st.dieSlow[node], die, dt, Math.min(DIE_SLOW_MS, snap.at - (st.startedAt ?? snap.at) + dt));
      if (!st.dieSeen[node]) st.dieSeen[node] = [];
      const seen = st.dieSeen[node];
      seen.push({ at: snap.at, v: st.dieSlow[node] });
      while (snap.at - seen[0].at > LEARN_RISE_MS) seen.shift();
      const ms = models[node].state();
      if (snap.at - (st.startedAt ?? snap.at) >= WARMUP_MS && Number.isFinite(ms.Peff)) st.restP[node] = Math.min(st.restP[node] ?? Infinity, ms.Peff);
      readings[node] = { die, power: Number.isFinite(power) ? power : null, Peff: ms.Peff, Pdev: ms.Pdev, dieSmooth: st.dieSmooth[node],
        hasPower: snap.at - (st.powerAt[node] || -Infinity) < POWER_FRESH_MS };
    }
    const core = val(snap.temps?.gpu);
    for (const extra of ['gpuMem', 'gpuHot']) {
      const v = val(snap.temps?.[extra]);
      if (v == null || core == null || untrusted.has(extra) || untrusted.has('gpu')) continue;
      st.offset[extra] = ema(st.offset[extra], v - core, dt, OFFSET_SMOOTH_MS);
      readings[extra] = { offset: st.offset[extra] };
    }
    if (val(snap.temps?.cpu) != null && !untrusted.has('cpu')) {
      st.dies.push(val(snap.temps.cpu));
      st.slows.push(models.cpu.state().S);
      if (st.dies.length > SPIKE_TICKS) { st.dies.shift(); st.slows.shift(); }
    }
    return { readings, measured: fr };
  }

  // Drawing clearly more than at rest, or a die that keeps climbing: a game, a
  // render, a build.
  function working(node, readings) {
    const seen = st.dieSeen[node];
    if (seen?.length && seen[seen.length - 1].v - seen[0].v >= LEARN_RISE) return true;
    const rest = st.restP[node];
    const P = readings[node]?.Peff;
    return !Number.isFinite(rest) || !Number.isFinite(P) ? false : P > Math.max(rest * LEARN_POWER_X, rest + LEARN_POWER_W);
  }

  function pumpFraction(snap, kept) {
    const liquid = val(snap.temps?.liquid) ?? models.cpu.state().S;
    if (!Number.isFinite(liquid)) return 1;
    const low = Math.max(liquidLow.see(snap.at, [liquid]), Number.isFinite(kept) ? kept : -Infinity);
    const top = L.COMPONENTS.liquid.full - L.COMPONENTS.liquid.margin;
    const from = Math.max(PUMP.from, Math.min(top - PUMP.span, low));
    return PUMP.low + (1 - PUMP.low) * L.clamp01((liquid - from) / (top - from));
  }

  /**
   * @param {any} snap { at, temps, power, rpm, duty }
   * @param {any} ctx { mode, slider, allowZero, game, call, recording, hour, options, untrusted, stalled,
   *   driving: the fans run at what this returns (not watching) }
   */
  function tick(snap, ctx = {}) {
    const dt = st.at ? Math.max(100, snap.at - st.at) : 1000;
    st.at = snap.at;
    st.startedAt ??= snap.at;
    const { readings, measured } = observe(snap, dt, new Set(Array.isArray(ctx.untrusted) ? ctx.untrusted : []));
    // Decided once, on the first tick: a restart of seconds resumes (brain-resume.js).
    st.resume ??= resumeOf(last, snap.at, new Set(channels.map((ch) => ch.id))) || false;
    st.driving = ctx.driving === true;
    const start = startSpeeds(measured);
    if (st.resume) for (const [id, f] of Object.entries(st.resume.out)) if (Number.isFinite(start[id])) start[id] = Math.min(start[id], f);
    st.tookAt ??= st.resume ? { ...st.resume.tookAt } : {};
    for (const [id, f] of Object.entries(start)) st.tookAt[id] ??= f;
    const c = context.update({ ...ctx, now: snap.at, dtMs: dt, power: snap.power });
    const targets = {};
    const ceilings = {};
    for (const name of Object.keys(L.COMPONENTS)) {
      targets[name] = L.targetFor(name, c.bias, cpuName);
      ceilings[name] = L.fullAt(name, cpuName) - L.COMPONENTS[name].margin;
    }
    const live = Object.fromEntries(Object.entries(models).filter(([n]) => readings[n]));
    correction.step(targets, readings, dt);
    const since = snap.at - st.startedAt;
    const nodes = Object.keys(live);
    const learning = nodes.some((n) => !models[n].state().calibrated)
      && nodes.every((n) => st.dieSmooth[n] != null && st.dieSmooth[n] < targets[n] - LEARN_MARGIN && !working(n, readings));
    // A jammed fan, handed back to the board by the safety layer, moves no air: the plan
    // counts it as standing still, so the others take its share at once rather than once
    // the correction has learned the missing air (a front fan jammed mid-game in the simulator).
    const stalled = new Set(Array.isArray(ctx.stalled) ? ctx.stalled : []);
    const planned = stalled.size ? channels.map((ch) => (stalled.has(ch.id) ? { ...ch, controllable: false } : ch)) : channels;
    const p = makePlan({ channels: planned, models: live, readings, targets, ceilings, anticipate: c.anticipate, correction: correction.factors(), allowZero: ctx.allowZero === true, measured, bias: c.bias, previous: st.plan });
    st.plan = { ...p.fractions };
    // "Out of reach" is not said on a guess (an idle chip 25 degrees under its target
    // was called that while learning): only of a component already at its target.
    const impossible = p.impossible.filter((n) => (correction.overBy(n, targets, readings) ?? -Infinity) > -REACH_NEAR);
    correction.hold(impossible);
    // A fan Xenon has just taken starts from the speed it is turning at: no jump.
    const startAt = planned.map((ch) => ({ ...ch, startFrac: ch.startFrac ?? start[ch.id] }));
    const held = p.urgent.length > 0 ? p.fractions
      : since < WARMUP_MS ? { ...p.fractions, ...start }
        : learning ? Object.fromEntries(Object.entries(p.fractions).map(([id, f]) => [id, Math.min(f, st.out?.[id] ?? Infinity, st.tookAt[id] ?? Infinity)]))
          : p.fractions;
    const s = smoother.step({ now: snap.at, dtMs: dt, channels: startAt, fractions: held, urgent: p.urgent.length > 0, calm: c.calm, measured: snap.rpm, pumpFraction: pumpFraction(snap, readings.ambient + L.liquidRiseFor(c.bias)) });
    st.out = { ...s.fractions };
    const confidence = Math.min(...Object.keys(live).map((n) => models[n].confidence()).concat(1));
    const predicted = {};
    for (const [n, m] of Object.entries(live)) {
      const P = Math.max(readings[n].Peff ?? 0, c.anticipate[n] || 0);
      predicted[n] = Math.round((m.predict(s.fractions, P, readings.ambient, PREDICT_S) + m.coefficients().R * P) * 10) / 10;
    }
    return {
      duties: s.duties, fractions: s.fractions, planned: p.fractions, targets, predicted, bias: c.bias,
      binding: p.binding, impossible, urgent: p.urgent, noiseDb: p.noiseDb, confidence, ambient: readings.ambient,
      spike: R.spiked(st.dies, st.slows), contextReasons: c.reasons,
    };
  }

  return {
    tick,
    models,
    save: () => ({ cpu: models.cpu.save(), gpu: models.gpu.save(), air: air.save(), pumpLow: liquidLow.save() }),
    /** The speeds asked last, for the next brain if this one ends within seconds; null while watching. */
    last: () => lastOf(st),
    memory: () => context.memory(),
    /** What each source's heat is multiplied by for heat its model misses (1: none). */
    correction: () => correction.factors(),
    slow: () => ({ cpu: models.cpu.state(), gpu: models.gpu.state() }),
  };
}

module.exports = { createBrain };
