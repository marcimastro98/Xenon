'use strict';
// The moment a heat source's model is held to (brain-model.js). The windows alone can
// misplace where the slow node S would settle, so once S has sat still for STEADY_MS
// with the fans unchanged, that moment is kept (S's rise over the air, the power, the
// fans, the R S carried), and the heat the model plans with is scaled, at every use, so
// it predicts that rise there (`cal`, CAL.min-CAL.max). Kept as a moment, not as a
// factor: the windows keep moving the model and R keeps moving S, and a factor taken
// once went stale with them (S 6 degrees lower after R grew, the plan at full speed for
// minutes, seen on the same PC).
//
// The model's parameters come in the estimator's units (brain-model.js): theta =
// [heat, G0, fan k_i ...], heat x 1e5, the rest x 1e4.

const STEADY_SMOOTH_MS = 60000;
// The smoothing starts at the first reading and lags behind a node still on its way: a slope
// read over its first minutes is a fraction of the real one. After three time constants it
// reads nine tenths of it, and no moment is kept before.
const SMOOTH_READY_MS = 3 * STEADY_SMOOTH_MS;
const STEADY_MS = 90000;
const STEADY_DRIFT = 0.5;
const FANS_STILL = 0.03;
// After the fans change, a slow node keeps sliding for minutes, sometimes against
// the way it last moved (a card's heatsink sank for a minute after its fans had come
// back down, and a moment kept there planned a game 27 % too cool). No moment is
// kept until the fans have held still this long since a change it saw; the speeds
// found at the start count as settled (the steady test below still applies). A change
// counts when it moves this node's air by FANS_STILL of it: radiator fans following the
// CPU kept a card's clock at zero though they hardly reach it, and a moment kept with
// the case air of a cold morning held its plan twice too warm all day (24 Nov 2026).
const FANS_SETTLED_MS = 300000;
const CAL_MIN_RISE = 2;
// The rise is read through S = die - R P, so R a sixth off moves it by a sixth of
// R P: a moment whose rise is under RISE_SHARE of R P could be half error, and is not
// kept (an AIO in a simulated game showed 4 degrees under 27 of R P, and its scale
// swung from half to double with each new moment). A real liquid is read, not derived
// through R, and is kept whatever its share: a 360 AIO at 50 W sits 3-4 K over its air,
// under a third of an X3D's R P, so no new moment was ever kept on it and one kept warm and
// early held its radiator and a case fan at 80 % for good (25 Nov 2026).
const RISE_SHARE = 0.3;
// A new moment replaces the kept one only when it moves the scale by more than
// this share: in a long game a moment a minute, each a hair off the last, kept
// nudging the plan between two equal mixes that did not cool the card the same.
const ANCHOR_BAND = 0.05;
// Still is not settled: a slow node can creep toward where it settles slower than
// STEADY_DRIFT in STEADY_MS. The creep seen is added back through the model's heat
// capacity, and a moment that still creeps by more than this share of its heat is
// not kept. The capacity is the model's least sure number and the creep's share of the
// heat scales the rise by 1/(1 - share): at a half a liquid still warming read twice
// its rise, and a model learned on another loop held its radiator at 0.4 where 0.2
// held the same die (24 Nov 2026).
const CREEP_MAX = 0.25;
const CAL = Object.freeze({ min: 0.25, max: 2 });

const ema = (prev, x, dtMs, tauMs) => (prev == null ? x : prev + (x - prev) * (1 - Math.exp(-dtMs / tauMs)));

/**
 * @param {{ theta: () => number[], windowMs: number }} o theta: the model's parameters now;
 *   windowMs: how often see() is called
 */
function createAnchor({ theta, windowMs }) {
  let Sslow = null;
  let Pslow = null;
  let smoothedMs = 0;
  /** @type {{ at: number, slow: number }[]} */
  const still = [];
  /** @type {{ F: number[], since: number }|null} */
  let fansAt = null;
  /** @type {{ rise: number, P: number, F: number[], R: number }|null} */
  let anchor = null;

  // The fans moved this node's air (b0 + sum b_i F_i) by FANS_STILL of it since `F0`.
  function moved(F0, F) {
    const th = theta();
    const air = th[1] + F0.reduce((s, f, i) => s + th[2 + i] * f, 0);
    return F.reduce((s, f, i) => s + th[2 + i] * Math.abs(f - F0[i]), 0) >= FANS_STILL * air;
  }

  // The scale that makes the model, as it is now, predict a moment's rise; a rise read
  // through die - R P is moved by what the R S carries changed since. A real liquid is
  // read as it is: moved by R, whose ratio swings with the load, a moment at 42 W read
  // four degrees warmer than the liquid had been (24 Nov 2026).
  function calFor(m, now) {
    const th = theta();
    const a = th[1] + m.F.reduce((s, f, i) => s + th[2 + i] * f, 0);
    const predicted = (th[0] * 0.1 * m.P) / a;
    const rise = m.rise + (now.real ? 0 : (m.R - now.R) * m.P);
    if (!(a > 0) || !(predicted > 0) || !Number.isFinite(rise)) return 1;
    return Math.min(CAL.max, Math.max(CAL.min, rise / predicted));
  }

  return {
    /** Every tick: S and the power, seen over a minute. */
    smooth(S, P, dt) {
      smoothedMs += dt;
      Sslow = ema(Sslow, S, dt, STEADY_SMOOTH_MS);
      Pslow = ema(Pslow, P, dt, STEADY_SMOOTH_MS);
    },
    /**
     * Every window: keeps the moment when S and the fans sit still.
     * @param {number} at @param {number} Ta the air @param {number[]} F the fans' features
     * @param {{ R: number, real: boolean, ready: boolean }} now the R S carries, S is a real
     *   liquid, R is learned
     */
    see(at, Ta, F, now) {
      if (!fansAt) fansAt = { F, since: -Infinity };
      else if (moved(fansAt.F, F)) fansAt = { F, since: at };
      still.push({ at, slow: Sslow });
      while (at - still[0].at > STEADY_MS) still.shift();
      if (at - fansAt.since < FANS_SETTLED_MS || !now.ready || smoothedMs < SMOOTH_READY_MS) return;
      const span = (at - still[0].at) / 1000;
      if (span < (STEADY_MS - windowMs) / 1000) return;
      const creep = (Sslow - still[0].slow) / span;
      if (Math.abs(creep) * span > STEADY_DRIFT) return;
      const heat = (theta()[0] / 1e5) * Pslow;
      if (!(Sslow - Ta > Math.max(CAL_MIN_RISE, now.real ? 0 : RISE_SHARE * now.R * Pslow)) || !(heat > 0) || Math.abs(creep) > CREEP_MAX * heat) return;
      const seen = { rise: ((Sslow - Ta) * heat) / (heat - creep), P: Pslow, F, R: now.R };
      if (!anchor || Math.abs(calFor(seen, now) / calFor(anchor, now) - 1) > ANCHOR_BAND) anchor = seen;
    },
    /** @param {{ R: number, real: boolean }} now */
    cal: (now) => (anchor ? calFor(anchor, now) : 1),
    kept: () => anchor != null,
    save: () => anchor && { ...anchor, F: anchor.F.slice() },
    /** A moment saved with these same fans, `n` of them. @param {any} a @param {number} n */
    load(a, n, clampR) {
      const fansOk = Array.isArray(a?.F) && a.F.length === n && a.F.every((f) => Number.isFinite(f) && f >= 0 && f <= 1);
      if (fansOk && [a.rise, a.P, a.R].every(Number.isFinite) && a.rise > 0 && a.P > 0) anchor = { rise: a.rise, P: a.P, F: a.F.slice(), R: clampR(a.R) };
    },
  };
}

module.exports = { createAnchor };
