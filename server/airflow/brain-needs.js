'use strict';
// What each heat source needs from the air, for the planner (brain-plan.js).
//
// For a heat source with model m (brain-model.js) the slow node settles at
//   S_ss = Ta + theta1 P / alpha(r),  alpha(r) = b0 + sum_i b_i r_i^0.8
// and the die at S_ss + R P. Holding the die under a limit therefore needs
//   alpha(r) >= theta1 P / (limit - R P - Ta)
// one linear inequality in r_i^0.8.
const { EXP } = require('./brain-model.js');
const { liquidRiseFor } = require('./limits.js');

// The closest to the air a radiator under load is asked to hold its liquid: the aim's
// floor (aimOf). The liquid's comfort sits further over the air, as far as the slider
// says (limits.js LIQUID_RISE), and never past its ceiling.
const LIQUID_MIN_RISE = 6;
// Below this much room between a limit and ambient, no airflow can hold it.
const MIN_ROOM = 0.5;
const PDEV_K = 1.5; // power is planned at average + PDEV_K x typical swing
// An even swing peaks at twice its mean distance from the average: the die on a liquid
// planned at the average is planned at that peak (constraints).
const PEAK_K = 2;

// The highest the slow node may settle at under these limits (comfort targets or
// ceilings). GPU memory and hot spot ride on the core; a CPU on liquid also keeps
// the liquid under its own limit.
function slowLimit(node, limits, readings, rp) {
  let s = limits[node] - rp;
  for (const extra of node === 'gpu' ? ['gpuMem', 'gpuHot'] : []) {
    const x = readings[extra];
    if (x && Number.isFinite(x.offset) && Number.isFinite(limits[extra])) s = Math.min(s, limits[extra] - x.offset - rp);
  }
  if (node === 'cpu' && readings.liquidTarget && Number.isFinite(limits.liquid)) s = Math.min(s, limits.liquid);
  return s;
}

// The closest to the air a slow node can be held without absurd airflow: a radiator under
// load keeps its liquid a few degrees over the air it breathes; a heatsink in a fan's
// stream gets much closer.
const onLiquid = (node, readings) => node === 'cpu' && readings.liquidTarget === true;
const slowFloor = (node, readings) => (onLiquid(node, readings) ? LIQUID_MIN_RISE : 0);

/**
 * What each heat source needs, as minimum alpha (1/s):
 *   hard: what holds it under its ceilings (Infinity when nothing can: every fan
 *         then climbs to full);
 *   want: what holds it at its comfort targets, bought only while worth it;
 *   reach: want at the average power: "out of reach" is not said of a swing.
 * heat is theta1 x the power x the brain's correction, so heat / alpha is the slow node's
 * rise over ambient. The die's own R x P is planned at the average plus PDEV_K times the
 * typical swing, so a load that wobbles stays under target most of the time. So is a
 * heatsink in a fan's stream, which moves in tens of seconds: planned at the average, a
 * card in a simulated game ran its memory over target and its fans louder. A liquid takes
 * many minutes to move and is planned at the average: counted at the swing, a browser's
 * 45-80 W bursts were fifteen watts it never saw (24 Nov 2026). The swing's margin on the
 * liquid had also covered the die's peaks, so the die over it is planned at the swing's
 * peak (PEAK_K). The liquid's comfort is its target or the air plus what the slider allows
 * (liquidRiseFor), whichever is higher, never past its ceiling.
 * @param {{ models: any, readings: any, targets: Record<string, number>, ceilings?: Record<string, number>, anticipate?: Record<string, number>, correction?: Record<string, number>, bias?: number }} input
 * @returns {{ node: string, hard: number, want: number, reach: number, heat: number, model: any, power: number }[]}
 */
function constraints({ models, readings, targets, ceilings = {}, anticipate = {}, correction = {}, bias = 0.5 }) {
  const out = [];
  const Ta = readings.ambient;
  const comfort = { ...targets };
  if (Number.isFinite(targets.liquid)) comfort.liquid = Math.min(Math.max(targets.liquid, Ta + liquidRiseFor(bias)), ceilings.liquid ?? Infinity);
  const limits = { ...targets, ...ceilings };
  for (const [node, m] of Object.entries(models || {})) {
    const r = readings[node];
    if (!m || !r || !Number.isFinite(r.Peff) || !(r.hasPower)) continue;
    const P = Math.max(r.Peff + PDEV_K * (r.Pdev || 0), anticipate[node] || 0);
    const avg = Math.max(r.Peff, anticipate[node] || 0);
    const c = m.coefficients();
    const k = c.theta1 * (correction[node] || 1);
    const liquid = onLiquid(node, readings);
    const slow = liquid ? avg : P;
    const peak = liquid ? Math.max(r.Peff + PEAK_K * (r.Pdev || 0), anticipate[node] || 0) : P;
    // The slow node at `w` watts, the die's own R x P at `die` watts.
    const needAt = (lim, w, die) => { const room = slowLimit(node, lim, readings, c.R * die) - Ta; return room > MIN_ROOM ? (k * w) / room : Infinity; };
    out.push({
      node, model: m, power: P, heat: k * slow,
      // Ceilings at the average power: the slow node follows the average, and a swing lifts
      // the die by R x swing within a second whatever the fans do; the ceiling's margin is
      // there for that swing. Planned at average plus swing, a CPU on an all-core load (an
      // X3D at 90 W, its die 38 K over the liquid) looked past its ceiling and ran every fan
      // at full to take two degrees off a liquid already six over the air (23 Nov 2026).
      hard: needAt(limits, avg, avg), want: needAt(comfort, slow, peak), reach: needAt(comfort, avg, avg),
    });
  }
  return out;
}

/**
 * The lowest die the fans can be asked for: the target, or, when higher, the slow node at
 * its floor over the air (slowFloor) plus the die's own R x P at the power P (the average).
 * Past this aim the model is wrong (the brain corrects it) or heat is close (urgent);
 * between the target and the aim the fans can take a degree or two at a high price, so
 * comfort buys what it is worth and the correction learns nothing. An X3D at 90 W sits
 * 38 K over its liquid: a target of 73 there wound the correction up to four times the
 * heat and every fan to full (23 Nov 2026).
 * @param {string} node @param {number} target @param {any} readings @param {any} model @param {number} [P]
 */
function aimOf(node, target, readings, model, P = readings[node]?.Peff) {
  const Ta = readings.ambient;
  if (!Number.isFinite(target) || !model || !Number.isFinite(Ta) || !Number.isFinite(P)) return target;
  return Math.max(target, Ta + slowFloor(node, readings) + model.coefficients().R * P);
}

/** The air a source gets at these fan fractions (1/s). */
function alphaOf(con, frac) {
  const c = con.model.coefficients();
  return c.b0 + con.model.ids.reduce((s, id) => s + c.b[id] * (frac[id] ?? 0) ** EXP, 0);
}

module.exports = { constraints, alphaOf, aimOf, onLiquid, PDEV_K };
