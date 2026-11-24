'use strict';
// Chooses how fast every fan should turn: the quietest mix that keeps each
// component under its ceiling for sure, and at its comfort target whenever the
// degrees still missing are worth the noise they cost.
//
// What each component needs from the air is brain-needs.js: one linear inequality
// in r_i^0.8 per component. The planner starts every fan group at its
// floor and adds speed, a small step at a time, to the group that buys the most
// per decibel added (brain-noise.js): first until every ceiling holds, whatever
// the price, then toward the comfort targets while each step still buys enough
// degrees per decibel (the comfort slider sets how many). Sound adds as energy, so the
// cheapest decibels are on the slowest fans: the mix spreads over many quiet fans.
// Pricing comfort keeps the plan continuous: a target just within reach never costs full
// speed, one just out of reach not nothing. A working plan stays until a new one is clearly better (KEEP_DB).
const N = require('./brain-noise.js');
const { constraints, alphaOf, aimOf, PDEV_K } = require('./brain-needs.js');
const { depsFor } = require('./inventory.js');

const STEP = 0.02;
// 16 groups climbing from their floor to 100 % in STEPs, with room to spare.
const MAX_ITER = 1000;
const URGENT_HORIZON_S = 30;
const URGENT_OVER = 2;
// Without power readings the model has nothing to work with: a plain curve on
// the smoothed die temperature, from the floor at target-RAMP to full at target.
const RAMP = 15;
// Toward comfort, each step must buy this many degrees per decibel at the
// balanced setting (quieter settings ask more of it, cooler ones less), and at
// least MIN_STEP_C degrees: next to loud fans a slow one costs almost no
// decibels, which alone would spin up fans that do nothing.
const MIN_C_PER_DB = 0.3;
const MIN_STEP_C = 0.05;
// The previous plan stays while it still holds every ceiling, misses comfort by
// at most KEEP_C degrees more than the new plan would, and is within KEEP_DB of it:
// with several fans able to do the same job, two almost equal mixes can swap on
// every small change of load, and the user hears that.
const KEEP_DB = 1;
const KEEP_C = 0.5;
const worthAt = (bias) => MIN_C_PER_DB * (0.5 / Math.max(0.1, Number.isFinite(bias) ? bias : 0.5));

const clamp01 = (x) => Math.min(1, Math.max(0, x));

// What a fan is bought for: the components its safety hangs on (inventory.js). A
// card's own fans never for the CPU, a radiator's never for the card: their pull on
// the other is only the model's prior, and buying it spun a card to full for a CPU
// on its own cooler (a shadow run, 22 Nov). Fans for different components are never
// planned as one group either.
const servesOf = (ch) => new Set(Array.isArray(ch?.deps) ? ch.deps : depsFor(ch?.place || 'case', ch?.kind));
function groupsOf(fans) {
  const by = new Map();
  for (const c of fans) {
    const key = [...servesOf(c)].sort().join();
    by.set(key, [...(by.get(key) || []), c]);
  }
  return [...by.values()].flatMap((list) => N.beatGroups(list));
}

/** Noise of all fans at these fractions. */
function noiseOf(byId, frac) {
  return N.totalDb(Object.entries(frac).map(([id, f]) => N.fanDb(byId[id], f * (byId[id].maxRpm || 2000))));
}

// A group may stop when every fan in it stops safely and either the user allowed
// it or the device stops those fans by itself (a graphics card's zero-RPM mode).
function lowerBound(group, byId, allowZero) {
  const stoppable = group.every((id) => byId[id].zeroOk && (allowZero || byId[id].zeroByDefault));
  return stoppable ? 0 : Math.max(...group.map((id) => byId[id].minFrac ?? 0.2));
}

const minOf = (g, byId) => Math.max(...g.map((id) => byId[id].minFrac ?? 0.2));

// A group's next speed: from standstill straight to the fastest member's minimum.
const nextFrac = (g, byId, now) => (now === 0 ? Math.max(STEP, ...g.map((id) => byId[id].minFrac ?? 0.2)) : Math.min(1, now + STEP));

/**
 * What a step from frac to trial buys constraint c. Hard phase: the share of the
 * missing ceiling cooling it covers. Comfort phase: the degrees the slow node
 * drops, counting only those still above the target.
 */
function stepGain(c, frac, trial, hardPhase) {
  const a = alphaOf(c, frac);
  const b = alphaOf(c, trial);
  if (hardPhase) {
    const deficit = c.hard - a;
    if (!(deficit > 0)) return 0;
    return Number.isFinite(c.hard) ? Math.min(deficit, b - a) / c.hard : b - a;
  }
  const over = c.heat / a - c.heat / c.want;
  return over > 0 ? Math.min(over, c.heat / a - c.heat / b) : 0;
}

// Degrees a step drops on the sources still short of their ceiling: a fan that
// barely touches them (a card's fans for a CPU) is not spun up, even at any price.
const hardDegrees = (cons, frac, trial) => cons.reduce((s, c) => {
  const a = alphaOf(c, frac);
  return a < c.hard ? s + c.heat / a - c.heat / alphaOf(c, trial) : s;
}, 0);

/**
 * Greedy fill: every group starts at its floor; each step goes to the group that
 * buys the most per decibel. First every ceiling, at any price; then comfort,
 * while a step still buys `worth` degrees per decibel.
 */
function fill(groups, byId, cons, { allowZero, fixed, worth, start }) {
  const frac = { ...fixed };
  groups.forEach((g) => { const low = start?.has(g) ? minOf(g, byId) : lowerBound(g, byId, allowZero); for (const id of g) frac[id] = low; });
  const binding = new Set();
  const serves = groups.map((g) => servesOf(byId[g[0]]));
  for (let it = 0; it < MAX_ITER; it += 1) {
    const hardPhase = cons.some((c) => c.hard > alphaOf(c, frac));
    const base = noiseOf(byId, frac);
    let best = null;
    for (const [gi, g] of groups.entries()) {
      if (frac[g[0]] >= 1) continue;
      const trial = { ...frac };
      const next = nextFrac(g, byId, frac[g[0]]);
      for (const id of g) trial[id] = next;
      const served = cons.filter((c) => serves[gi].has(c.node));
      const gains = served.map((c) => stepGain(c, frac, trial, hardPhase));
      const gain = gains.reduce((a, x) => a + x, 0);
      if (!(gain > 0) || (hardPhase ? hardDegrees(served, frac, trial) : gain) < MIN_STEP_C) continue;
      const score = gain / Math.max(1e-3, noiseOf(byId, trial) - base);
      if (!best || score > best.score) best = { g, next, gains, served, score };
    }
    if (!best || (!hardPhase && best.score < worth)) break;
    best.gains.forEach((x, i) => { if (x > 0) binding.add(best.served[i].node); });
    for (const id of best.g) frac[id] = best.next;
  }
  return { frac, binding };
}

// A group's previous speed: down a STEP, to its minimum, then to its low.
function prevFrac(g, byId, now, low) {
  const min = minOf(g, byId);
  if (now - STEP >= min - 1e-9) return now - STEP;
  return now > min + 1e-9 ? min : low;
}

// Comfort degrees still missing: how far each slow node settles above its target.
const missing = (cons, frac) => cons.reduce((s, c) => s + Math.max(0, c.heat / alphaOf(c, frac) - c.heat / c.want), 0);

/**
 * The greedy fill never takes a step back: air bought early can turn redundant
 * once a later step (a stopped group starting) covers the same need. The step
 * back that costs the fewest comfort degrees per decibel saved is taken while
 * every ceiling holds and it costs less than the fill paid (or under MIN_STEP_C).
 */
function prune(groups, byId, cons, frac, { allowZero, worth }) {
  for (let it = 0; it < MAX_ITER; it += 1) {
    const base = noiseOf(byId, frac);
    const lost = missing(cons, frac);
    let best = null;
    for (const g of groups) {
      const low = lowerBound(g, byId, allowZero);
      const next = prevFrac(g, byId, frac[g[0]], low);
      if (!(next < frac[g[0]])) continue;
      const trial = { ...frac };
      for (const id of g) trial[id] = next;
      if (cons.some((c) => alphaOf(c, trial) < c.hard)) continue;
      const cost = missing(cons, trial) - lost;
      const ratio = cost / Math.max(1e-3, base - noiseOf(byId, trial));
      if (cost < MIN_STEP_C || ratio < worth) if (!best || ratio < best.ratio) best = { trial, ratio };
    }
    if (!best) return;
    Object.assign(frac, best.trial);
  }
}

// A stopped group starts in one big step, from 0 to its minimum, whose gain on a ceiling is
// capped by the deficit left: the fill buys many small steps elsewhere first, starts the
// group for comfort, and prune gives back only part of the air bought before, where it also
// held another source's comfort (a card at 150 W planned louder than at 180 W, 24 Nov 2026).
// So the plan is made again with the groups the first one started turning from the start,
// and the cheaper is kept: its noise plus the comfort degrees still missing, priced at what
// the fill pays for them.
function quietest(groups, byId, cons, how) {
  const run = (start) => {
    const out = fill(groups, byId, cons, { ...how, start });
    prune(groups, byId, cons, out.frac, how);
    return { ...out, cost: noiseOf(byId, out.frac) + missing(cons, out.frac) / how.worth };
  };
  const first = run(new Set());
  const started = new Set(groups.filter((g) => lowerBound(g, byId, how.allowZero) === 0 && first.frac[g[0]] > 0));
  if (!started.size) return first;
  const second = run(started);
  if (!(second.cost < first.cost)) return first;
  // A group started from the outset still turns for what the first plan started it for.
  for (const g of started) for (const n of servesOf(byId[g[0]])) if (first.binding.has(n) && second.frac[g[0]] > 0) second.binding.add(n);
  return second;
}

// lows: the least each fan may run at now (its floor, or the no-power curve).
function keepPrevious(prev, frac, { cons, byId, fixed, lows }) {
  if (!prev || Object.keys(frac).some((id) => !Number.isFinite(prev[id]) || prev[id] < lows[id])) return false;
  // A fan no longer driven (jammed, or left to the board) turns at what it reads, not at
  // what the last plan asked of it.
  const probe = { ...prev, ...fixed };
  const now = { ...fixed, ...frac };
  if (cons.some((c) => alphaOf(c, probe) < c.hard)) return false;
  // Only comfort lost counts: a plan cooler than needed is no reason to switch.
  if (missing(cons, probe) - missing(cons, now) > KEEP_C) return false;
  return Math.abs(noiseOf(byId, now) - noiseOf(byId, probe)) < KEEP_DB;
}

/** Plain curve for nodes without power readings, per fan that cools them. */
function curveFloor(models, readings, targets, byId) {
  const floor = {};
  for (const [node, m] of Object.entries(models || {})) {
    const r = readings[node];
    if (!m || !r || r.hasPower || !Number.isFinite(r.dieSmooth)) continue;
    const f = clamp01((r.dieSmooth - (targets[node] - RAMP)) / RAMP);
    const c = m.coefficients();
    for (const id of m.ids) if (c.b[id] > c.b0 * 0.05 && servesOf(byId[id]).has(node)) floor[id] = Math.max(floor[id] || 0, f);
  }
  return floor;
}

/**
 * True when heat is close: the die, at today's fan speeds and power, gets over its aim soon
 * (the target, or what the fans can reach under an all-core load: aimOf).
 * Read on the smoothed die and power: a Ryzen bursts to its target for a second when an
 * app opens, and each burst called urgent ramped the fans past the learning hold, where
 * they stayed (a 360 AIO at 80 % on an idle PC, 23 Nov 2026). A real load keeps the
 * averages up within seconds; the safety layer answers real heat on its own.
 */
function urgency({ models, readings, targets, measured }) {
  const hot = [];
  for (const [node, m] of Object.entries(models || {})) {
    const r = readings[node];
    const now = Number.isFinite(r?.dieSmooth) ? r.dieSmooth : r?.die;
    if (!m || !r || !Number.isFinite(now) || !Number.isFinite(targets[node])) continue;
    const P = Number.isFinite(r.Peff) ? r.Peff : Number.isFinite(r.power) ? r.power : 0;
    const die = m.predict(measured, P, readings.ambient, URGENT_HORIZON_S) + m.coefficients().R * P;
    const aim = aimOf(node, targets[node], readings, m);
    if (now > aim + URGENT_OVER || die > aim + URGENT_OVER) hot.push(node);
  }
  return hot;
}

/**
 * @param {{ channels: any[], models: Record<string, any>, readings: any, targets: Record<string, number>,
 *   ceilings?: Record<string, number>, anticipate?: Record<string, number>, correction?: Record<string, number>, allowZero?: boolean,
 *   measured?: Record<string, number>, bias?: number, previous?: Record<string, number>|null }} input
 */
function plan(input) {
  const all = (input.channels || []).filter((c) => c.kind !== 'pump');
  const fans = all.filter((c) => c.controllable);
  const byId = Object.fromEntries(all.map((c) => [c.id, c]));
  // Fans Xenon does not drive still move air and make noise: they count at the
  // speed they turn at, fixed.
  const fixed = {};
  for (const c of all) if (!c.controllable && Number.isFinite(input.measured?.[c.id])) fixed[c.id] = input.measured[c.id];
  const top = { ...fixed, ...Object.fromEntries(fans.map((c) => [c.id, 1])) };
  const groups = groupsOf(fans);
  const cons = constraints(input);
  const how = { allowZero: input.allowZero === true, fixed, worth: worthAt(input.bias) };
  const { frac, binding } = quietest(groups, byId, cons, how);
  for (const id of Object.keys(fixed)) delete frac[id];
  const floor = curveFloor(input.models, input.readings, input.targets, byId);
  const lows = {};
  for (const g of groups) {
    const f = Math.max(...g.map((id) => floor[id] || 0));
    const low = lowerBound(g, byId, input.allowZero === true);
    for (const id of g) lows[id] = f > 0 ? Math.max(f, byId[id].minFrac ?? 0.2) : low;
    if (f > frac[g[0]]) for (const id of g) frac[id] = lows[id];
  }
  // Groups close in RPM are pulled together, then resonance zones skipped.
  const rpm = Object.fromEntries(groups.map((g, gi) => [String(gi), frac[g[0]] * (byId[g[0]].maxRpm || 2000)]));
  const together = N.unbeat(rpm);
  groups.forEach((g, gi) => {
    for (const id of g) {
      const max = byId[id].maxRpm || 2000;
      const want = N.avoidZones(together[String(gi)], byId[id].avoid, true);
      frac[id] = clamp01(Math.max(frac[id], want / max));
    }
  });
  const kept = keepPrevious(input.previous, frac, { cons, byId, fixed, lows });
  if (kept) for (const id of Object.keys(frac)) frac[id] = input.previous[id];
  return {
    fractions: frac,
    kept,
    binding: [...binding],
    // Out of reach: even every fan at full leaves it above its comfort target.
    impossible: cons.filter((c) => alphaOf(c, top) < c.reach).map((c) => c.node),
    urgent: urgency({ ...input, measured: input.measured || frac }),
    noiseDb: noiseOf(byId, frac),
  };
}

module.exports = { plan, constraints, groupsOf, STEP, RAMP, PDEV_K, MIN_C_PER_DB, MIN_STEP_C };
