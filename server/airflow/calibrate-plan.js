'use strict';
// What the fan check (calibrate.js) moves and for how long: each channel as the check
// takes it (checked, a pump's floor, a slow driver's settle time, beta or not), the duty
// steps the sweep walks down, and the time the whole check may take.
const L = require('./limits.js');
const Model = require('../js/airflow/airflow-model.js');
const { SETTLE } = require('./calibrate-settle.js');
const { BACK_MS } = require('./calibrate-back.js');

const SWEEP = Object.freeze([80, 60, 45, 35, 25, 20, 15, 10, 5, 0]);
// The longest a driver may say its fans take to settle (settleMs on a channel).
const SLOW_SETTLE_MAX_MS = 45000;
const MAX_MS = 6 * 60000;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * @typedef {{ id: string, kind?: 'fan'|'pump', tach?: string|null, floor?: number, settleMs?: number, beta?: boolean }} CheckChannel
 *   beta: a control Xenon never tried on real hardware, which must also prove it goes back
 */

/** @param {CheckChannel[]} list */
function cleanChannels(list) {
  const seen = new Set();
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || !Model.isFanId(c.id) || seen.has(c.id) || out.length >= Model.MAX_FANS) continue;
    seen.add(c.id);
    const kind = c.kind === 'pump' ? 'pump' : 'fan';
    const floor = Math.max(isNum(c.floor) ? Math.min(100, Math.max(0, c.floor)) : 0, kind === 'pump' ? L.PUMP_FLOOR : 0);
    const settleMs = isNum(c.settleMs) ? Math.min(SLOW_SETTLE_MAX_MS, Math.max(SETTLE.maxMs, c.settleMs)) : SETTLE.maxMs;
    out.push({ id: c.id, kind, floor, tach: Model.isFanId(c.tach) ? c.tach : null, settleMs, beta: c.beta === true });
  }
  return out;
}

// The check's time limit: MAX_MS, plus what slow fans may take on top at each step
// (their own pairing, the spin and every sweep step), plus the beta controls' last
// step (back to full, then the PC's time to slow them).
function budgetMs(chs) {
  const extra = chs.map((c) => c.settleMs - SETTLE.maxMs).filter((x) => x > 0);
  const slow = extra.length ? extra.reduce((a, b) => a + b, 0) + (SWEEP.length + 1) * Math.max(...extra) : 0;
  const beta = chs.filter((c) => c.beta).map((c) => c.settleMs);
  const back = beta.length ? Math.max(...beta) + Math.max(BACK_MS, ...beta) : 0;
  return MAX_MS + slow + back;
}

const pointsFor = (ch) => [...SWEEP.filter((d) => d > ch.floor), ch.floor];

module.exports = { cleanChannels, budgetMs, pointsFor, SWEEP, MAX_MS, SLOW_SETTLE_MAX_MS };
