'use strict';
// The integral correction (brain.js): if a source sits over its target for a while although
// the plan says it should not, its model misses heat somewhere, and the heat the plan counts
// for it grows until the die obeys (never under what the model asks: a wrong model costs
// noise, never heat). It grows while the die sits over its aim, never while the plan already
// gives that source all the air there is (it would only wind up and keep the fans loud long
// after), and falls fast once the die is well below. A card's memory and hot spot count as
// its die: their offset is learned too, and a game that warmed the memory past its target
// for an hour went unanswered.
const { aimOf, onLiquid } = require('./brain-needs.js');

const CORR = Object.freeze({ over: 1, rise: 0.004, fall: 0.001, fallFast: 0.01, below: 3, max: 4 });
// It learns only from heat the fans could have taken. The die rides R x P over its slow node
// within a second, whatever the fans do, so that part is read against the power the slow node
// has had time to follow: the average for a heatsink, which follows in seconds, and the last
// minutes for a liquid, which the fans move only over minutes. Read against the half-minute
// average, an X3D's 10-30 s bursts to 75-85 W put its smoothed die 2-4 degrees over target
// with the liquid where the plan held it; the correction grew to 1.6 times the heat and held
// the radiator and a case fan at 75 % on a CPU at 60 (24 Nov 2026).
const LIQUID_POWER_MS = 120000;

const ema = (prev, x, dt, tau) => (prev == null ? x : prev + (x - prev) * (1 - Math.exp(-dt / tau)));

/**
 * @param {{ models: Record<string, any>, smoothMs: number }} o smoothMs: how the die is
 *   smoothed (readings[node].dieSmooth); the power is smoothed alike to take its swing off
 */
function createCorrection({ models, smoothMs }) {
  const factor = { cpu: 1, gpu: 1 };
  /** @type {Record<string, { now?: number, slow?: number }>} */
  const power = { cpu: {}, gpu: {} };
  let maxed = new Set();

  // How far a source's smoothed die sits over `aim`, its card's memory and hot spot over theirs.
  function overBy(node, aim, targets, readings) {
    const d = readings[node]?.dieSmooth;
    if (!Number.isFinite(d) || !Number.isFinite(aim)) return null;
    let over = d - aim;
    if (node === 'gpu') {
      for (const x of ['gpuMem', 'gpuHot']) {
        const off = readings[x]?.offset;
        if (Number.isFinite(off) && Number.isFinite(targets[x])) over = Math.max(over, d + off - targets[x]);
      }
    }
    return over;
  }

  // The power the slow node has had time to follow.
  const followed = (node, readings) => (onLiquid(node, readings) ? power[node].slow : readings[node]?.Peff);

  /** Every tick, after the readings. @param {Record<string, number>} targets */
  function step(targets, readings, dt) {
    const s = dt / 1000;
    for (const node of ['cpu', 'gpu']) {
      const r = readings[node];
      if (!r || !models[node]) continue;
      if (Number.isFinite(r.power)) {
        power[node].now = ema(power[node].now, r.power, dt, smoothMs);
        power[node].slow = ema(power[node].slow, r.power, dt, LIQUID_POWER_MS);
      }
      const base = followed(node, readings);
      const R = models[node].coefficients().R;
      const swing = Number.isFinite(power[node].now) && Number.isFinite(base) ? R * (power[node].now - base) : 0;
      const raw = overBy(node, aimOf(node, targets[node], readings, models[node], base), targets, readings);
      if (raw == null) continue;
      const over = raw - swing;
      if (over > CORR.over) {
        if (!maxed.has(node)) factor[node] = Math.min(CORR.max, factor[node] * Math.exp(CORR.rise * over * s));
      } else {
        factor[node] = Math.max(1, factor[node] * Math.exp(-(over < -CORR.below ? CORR.fallFast : CORR.fall) * s));
      }
    }
  }

  return {
    step,
    /** How far each source sits over its target. @param {Record<string, number>} targets */
    overBy: (node, targets, readings) => overBy(node, targets[node], targets, readings),
    /** Sources whose plan already has all the air there is: their factor does not grow. */
    hold: (nodes) => { maxed = new Set(nodes); },
    /** What each source's heat is multiplied by (1: none). */
    factors: () => ({ ...factor }),
  };
}

module.exports = { createCorrection, CORR };
