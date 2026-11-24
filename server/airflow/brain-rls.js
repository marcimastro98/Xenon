'use strict';
// Online parameter estimation for the thermal model (brain-model.js): recursive
// least squares in its Kalman form, y = theta . phi + noise, with a small random
// walk on the parameters instead of a forgetting factor. A forgetting factor
// makes the covariance grow without bound whenever the data stops varying (a PC
// idling for hours with its fans at one speed), and the next disturbance then
// throws the parameters around; a random walk grows it slowly and linearly.
// Parameters are kept at or above `floor` (physics: heat capacity and
// conductances are positive) and the state is plain arrays, so the store can
// save and restore it.

/**
 * @param {{ theta: number[], variance: number[], noise: number, drift: number[],
 *   floor?: number[] }} opts prior mean, prior variance per parameter, measurement
 *   noise variance, per-update parameter drift variance
 */
function createEstimator({ theta, variance, noise, drift, floor = [] }) {
  const n = theta.length;
  let th = theta.slice();
  // Full covariance, n x n, starting diagonal.
  let P = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? variance[i] : 0)));
  const P0 = variance.slice();
  let updates = 0;

  /** One observation. Returns the prediction error before the update. */
  function update(phi, y) {
    if (phi.length !== n || !phi.every(Number.isFinite) || !Number.isFinite(y)) return null;
    for (let i = 0; i < n; i += 1) P[i][i] += drift[i];
    const Pphi = P.map((row) => row.reduce((s, v, j) => s + v * phi[j], 0));
    const denom = noise + phi.reduce((s, v, i) => s + v * Pphi[i], 0);
    if (!(denom > 0)) return null;
    const err = y - phi.reduce((s, v, i) => s + v * th[i], 0);
    const K = Pphi.map((v) => v / denom);
    th = th.map((v, i) => Math.max(floor[i] ?? -Infinity, v + K[i] * err));
    P = P.map((row, i) => row.map((v, j) => v - K[i] * Pphi[j]));
    // Symmetric and with a positive diagonal, whatever rounding did.
    for (let i = 0; i < n; i += 1) {
      P[i][i] = Math.max(P[i][i], 1e-12);
      for (let j = i + 1; j < n; j += 1) { const m = (P[i][j] + P[j][i]) / 2; P[i][j] = m; P[j][i] = m; }
    }
    updates += 1;
    return err;
  }

  /** 0 = nothing learned yet, 1 = every parameter known far better than the prior. */
  function confidence() {
    let s = 0;
    for (let i = 0; i < n; i += 1) s += Math.min(1, Math.sqrt(P[i][i] / P0[i]));
    return Math.max(0, Math.min(1, 1 - s / n));
  }

  return {
    update,
    confidence,
    theta: () => th.slice(),
    updates: () => updates,
    save: () => ({ theta: th.slice(), P: P.map((r) => r.slice()), updates }),
    /**
     * Restores a saved state; anything unusable is ignored. `map` gives, for each
     * parameter, its index in a state saved with other inputs (-1: new, from the
     * prior), so what both share is kept; without it the sizes must match.
     * @param {any} state
     * @param {number[]|null} [map]
     */
    load(state, map = null) {
      const k = Array.isArray(state?.theta) ? state.theta.length : -1;
      const m = map ?? (k === n ? theta.map((_, i) => i) : []);
      if (k < 0 || !state.theta.every(Number.isFinite) || m.length !== n || m.some((j) => !Number.isInteger(j) || j < -1 || j >= k)) return false;
      if (!Array.isArray(state.P) || state.P.length !== k || !state.P.every((r) => Array.isArray(r) && r.length === k && r.every(Number.isFinite))) return false;
      th = m.map((j, i) => Math.max(floor[i] ?? -Infinity, j < 0 ? theta[i] : state.theta[j]));
      P = m.map((a, i) => m.map((b, j) => (a >= 0 && b >= 0 ? state.P[a][b] : i === j ? variance[i] : 0)));
      updates = Number.isFinite(state.updates) ? state.updates : 0;
      return true;
    },
  };
}

module.exports = { createEstimator };
