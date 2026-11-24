'use strict';
// The thermal model of one heat source (CPU or GPU), learned while the PC runs.
//
// Two nodes. The die answers power within a second or two: die = S + R * P.
// The slow node S (the AIO's liquid, or an air cooler's heatsink) is what the
// fans actually cool, and it moves over minutes:
//   C dS/dt = P - (G0 + sum_i k_i * r_i^0.8) * (S - Ta)
// r_i is fan i's speed as a fraction of its maximum (airflow follows RPM; heat
// transfer follows airflow to about the 0.8 power), Ta the air the cooler
// breathes (the board's own temperature when it has one).
//
// Why two nodes: a Ryzen jumps 10 degrees opening a web page and falls back as
// fast. That jump is R * P, the die riding on the slow node; S did not move, so
// no fan needs to either. Fans driven by S (or by the real liquid sensor, when the
// AIO has one) stay still through spikes, and still hold the die where it must be.
//
// R comes from the steps: when power jumps, the die follows within seconds while
// S has no time to move, so dT/dP over those seconds is R. The rest is linear in
// the parameters and learned by brain-rls.js from 5-second windows.
//
// The windows alone can misplace where S would settle. At idle the fans never
// change, so nothing tells the case fans' share from the cooler's own, and a die
// that lags the power or an R a little off tilts every window the same way: on a
// warm-idling X3D whose AIO another app runs, the model came to see a slow node
// that would never stop warming and planned full speed (22 Nov 2026). So the
// model is also held to a moment it saw S sit still (brain-anchor.js).
const { createEstimator } = require('./brain-rls.js');
const { createAnchor } = require('./brain-anchor.js');

const WINDOW_MS = 5000;
const S_SMOOTH_MS = 20000;
const P_SMOOTH_MS = 30000;
const STEP_LOOKBACK = 3;
const STEP_SETTLE = 4;
const R_SAMPLES = 15;
// One step is not R: what the die shows a few seconds after a step depends on
// what the power did around it (a burst over before the die caught up read 0.8 on
// a chip near 0.4). R leaves its prior once this many steps give a median.
const R_MIN_SAMPLES = 5;
const AMBIENT_FALLBACK = 30;
const EXP = 0.8;
// A window whose slope is more than twice what all the power could do to the slow
// node, plus RATE_SLACK mK/s, is a jump of the estimate, not heat: not learned from.
const RATE_SLACK = 150;
// Priors: deliberately modest fan conductances, so an untrained model asks for a little
// more air than needed, never less. W/K at full speed; for the cooler's own fans
// ('radiator', 'cpu', 'gpu') the value is shared among them, for case fans per fan. A
// cooler none of whose fans Xenon drives (an AIO its own app runs) still cools: `hidden`
// joins G0. G0 is never learned under G0_KEEP of its prior: fans that never stop cannot
// tell it from theirs (a 105 W scan ran a case fan at full, an idle card's fans spun).
const G0_KEEP = 0.5;
const PRIORS = Object.freeze({
  cpu: { C: 1500, G0: 1.0, hidden: 12, R: 0.25, Rmin: 0.05, Rmax: 0.8, stepW: 15,
    shared: { radiator: 12, cpu: 10 }, each: { top: 1.2, rear: 1.2, front: 0.8, bottom: 0.4, side: 0.6, case: 0.8, gpu: 0.1 } },
  gpu: { C: 900, G0: 1.5, hidden: 25, R: 0.06, Rmin: 0.01, Rmax: 0.3, stepW: 40,
    shared: { gpu: 25 }, each: { front: 1.2, bottom: 1.5, side: 1.2, case: 1.0, top: 0.4, rear: 0.4, radiator: 0.2, cpu: 0.2 } },
});

// Units the estimator works in, so every parameter is of order 1-100:
// y = dS/dt in milli-degrees per second;
// phi = [P/100, -(S-Ta)/10, -r_i^0.8 (S-Ta)/10 ...]
const toTheta1 = (a) => a / 1e5;
const toPerSecond = (b) => b / 1e4;

function priorsFor(node, channels) {
  const p = PRIORS[node];
  const count = {};
  for (const ch of channels) count[ch.place] = (count[ch.place] || 0) + 1;
  const k = channels.map((ch) => (p.shared[ch.place] != null ? p.shared[ch.place] / count[ch.place] : p.each[ch.place] ?? p.each.case));
  const hidden = !channels.some((ch) => p.shared[ch.place] != null);
  return { theta: [1e5 / p.C, ((p.G0 + (hidden ? p.hidden : 0)) / p.C) * 1e4, ...k.map((ki) => (ki / p.C) * 1e4)], p, hidden };
}

const ema = (prev, x, dtMs, tauMs) => (prev == null ? x : prev + (x - prev) * (1 - Math.exp(-dtMs / tauMs)));
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

/**
 * @param {{ node: 'cpu'|'gpu', channels: { id: string, place: string }[] }} opts
 */
function createNodeModel({ node, channels }) {
  const ids = channels.map((c) => c.id);
  const { theta, p, hidden } = priorsFor(node, channels);
  const est = createEstimator({
    theta,
    variance: theta.map((v) => (0.6 * v) ** 2),
    noise: 900,
    drift: theta.map((v) => (0.002 * v) ** 2),
    floor: theta.map((v, i) => (i === 0 ? v * 0.2 : i === 1 ? v * G0_KEEP : v * 0.02)),
  });
  let R = p.R;
  // The R that S carries: S follows a new R over S_SMOOTH_MS, so the die the planner
  // rebuilds (S + R P) has to use the same mix, or a new R opens a hole of degrees
  // for as long as S takes to follow.
  let Rs = null;
  const rSamples = [];
  /** @type {{ at: number, die: number, power: number }[]} */
  const recent = [];
  let S = null;
  // S is the real liquid: a moment kept there does not move with R (brain-anchor.js).
  let real = false;
  const moment = createAnchor({ theta: () => est.theta(), windowMs: WINDOW_MS });
  let Peff = null;
  let Pdev = 0;
  let last = null;
  let win = null;
  let quietUntil = 0;

  const feature = (fr) => ids.map((id) => Math.max(0, Math.min(1, fr?.[id] ?? 0)) ** EXP);

  function learnR() {
    // recent[] holds one sample per tick; a step is a jump in power between
    // STEP_LOOKBACK ticks ago and now, judged once STEP_SETTLE ticks have passed.
    const n = recent.length;
    if (n < STEP_LOOKBACK + STEP_SETTLE + 1) return;
    const before = recent[n - 1 - STEP_SETTLE - STEP_LOOKBACK];
    const at = recent[n - 1 - STEP_SETTLE];
    const after = recent[n - 1];
    const dP = after.power - before.power;
    if (Math.abs(at.power - before.power) < p.stepW || Math.abs(dP) < p.stepW) return;
    // One step, one sample: the sliding window would otherwise count it once per tick.
    if (after.at < quietUntil) return;
    quietUntil = after.at + (STEP_LOOKBACK + STEP_SETTLE) * 1000;
    const r = (after.die - before.die) / dP;
    if (!Number.isFinite(r) || r <= 0) return;
    rSamples.push(Math.min(p.Rmax, Math.max(p.Rmin, r)));
    if (rSamples.length > R_SAMPLES) rSamples.shift();
    if (rSamples.length >= R_MIN_SAMPLES) R = median(rSamples);
  }

  const now = () => ({ R: Rs ?? R, real, ready: rSamples.length >= R_MIN_SAMPLES });
  const calNow = () => moment.cal(now());

  /**
   * One reading per tick.
   * @param {{ at: number, die: number, power: number|null, ambient?: number|null,
   *   fractions: Record<string, number>, liquid?: number|null }} o
   */
  function observe(o) {
    if (!Number.isFinite(o.at) || !Number.isFinite(o.die)) return;
    const P = Number.isFinite(o.power) ? o.power : 0;
    const Ta = Number.isFinite(o.ambient) ? o.ambient : AMBIENT_FALLBACK;
    const dt = last ? Math.max(1, o.at - last.at) : 1000;
    recent.push({ at: o.at, die: o.die, power: P });
    if (recent.length > STEP_LOOKBACK + STEP_SETTLE + 2) recent.shift();
    if (Number.isFinite(o.power)) learnR();
    // A real liquid sensor is the slow node; R is then die minus liquid per watt.
    real = Number.isFinite(o.liquid);
    if (real) {
      S = o.liquid;
      if (P > p.stepW) R = ema(R, Math.min(p.Rmax, Math.max(p.Rmin, (o.die - o.liquid) / P)), dt, 60000);
      Rs = R;
    } else {
      S = ema(S, o.die - R * P, dt, S_SMOOTH_MS);
      Rs = ema(Rs, R, dt, S_SMOOTH_MS);
    }
    moment.smooth(S, P, dt);
    Pdev = Peff == null ? 0 : ema(Pdev, Math.abs(P - Peff), dt, P_SMOOTH_MS);
    Peff = ema(Peff, P, dt, P_SMOOTH_MS);
    last = { at: o.at };
    if (!win) win = { start: o.at, S0: S, sumP: 0, sumTa: 0, sumF: ids.map(() => 0), n: 0 };
    win.sumP += P; win.sumTa += Ta; win.n += 1;
    feature(o.fractions).forEach((f, i) => { win.sumF[i] += f; });
    if (o.at - win.start >= WINDOW_MS && Number.isFinite(o.power)) {
      const span = (o.at - win.start) / 1000;
      const Sm = (win.S0 + S) / 2;
      const Tam = win.sumTa / win.n;
      const dTa = (Sm - Tam) / 10;
      const y = ((S - win.S0) / span) * 1000;
      const Pm = win.sumP / win.n;
      const F = win.sumF.map((f) => f / win.n);
      if (Math.abs(y) < RATE_SLACK + (2000 * Pm) / p.C) est.update([Pm / 100, -dTa, ...F.map((f) => -f * dTa)], y);
      moment.see(o.at, Tam, F, now());
      win = null;
    } else if (o.at - win.start >= WINDOW_MS) {
      win = null;
    }
  }

  /** The numbers the planner needs, in physical units. */
  function coefficients() {
    const th = est.theta();
    const b = {};
    ids.forEach((id, i) => { b[id] = toPerSecond(th[2 + i]); });
    return { theta1: toTheta1(th[0]) * calNow(), b0: toPerSecond(th[1]), b, R: Rs ?? R };
  }

  /** 1/s: how fast the slow node relaxes toward ambient at these fan speeds. */
  function alpha(fractions) {
    const c = coefficients();
    return c.b0 + feature(fractions).reduce((s, f, i) => s + c.b[ids[i]] * f, 0);
  }

  /** Slow-node temperature this power would settle at, with these fans. */
  function steady(fractions, power, ambient) {
    return ambient + (coefficients().theta1 * power) / alpha(fractions);
  }

  /** Slow-node temperature after `seconds`, power and fans held. */
  function predict(fractions, power, ambient, seconds) {
    const a = alpha(fractions);
    const ss = ambient + (coefficients().theta1 * power) / a;
    const from = S ?? ss;
    return ss + (from - ss) * Math.exp(-a * seconds);
  }

  return {
    node, ids, observe, coefficients, alpha, steady, predict,
    state: () => ({ S, R, Peff, Pdev, cal: calNow(), calibrated: moment.kept() }),
    confidence: () => est.confidence(),
    save: () => ({ ids: ids.slice(), hidden, est: est.save(), R, Rs, rSamples: rSamples.slice(), anchor: moment.save() }),
    load(saved) {
      if (!saved || typeof saved !== 'object') return false;
      // Fans left to the PC or added keep what was learned of the others; the kept
      // moment was seen with the old fans and is taken again.
      const was = Array.isArray(saved.ids) ? saved.ids : null;
      const same = !was || (was.length === ids.length && was.every((id, i) => id === ids[i]));
      const clampR = (r) => Math.min(p.Rmax, Math.max(p.Rmin, r));
      // Learned with the cooler counted the other way (or before it was counted): its
      // numbers mean something else, only R, the die over its cooler, stays.
      const kept = (saved.hidden === true) === hidden;
      if (kept && !est.load(saved.est, same ? null : [0, 1, ...ids.map((id) => (was.includes(id) ? was.indexOf(id) + 2 : -1))])) return false;
      if (Number.isFinite(saved.R)) R = clampR(saved.R);
      if (Array.isArray(saved.rSamples)) rSamples.splice(0, rSamples.length, ...saved.rSamples.filter(Number.isFinite).slice(-R_SAMPLES).map(clampR));
      if (!kept) return false;
      if (Number.isFinite(saved.Rs)) Rs = clampR(saved.Rs);
      if (same) moment.load(saved.anchor, ids.length, clampR);
      return true;
    },
  };
}

module.exports = { createNodeModel, PRIORS, EXP, AMBIENT_FALLBACK };
