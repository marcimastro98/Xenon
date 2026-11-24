'use strict';
// What the fan check measured, turned into what Airflow keeps about each control
// (airflow-model.js normalizeCalib): which speed readings it moves, its top speed,
// its duty-to-RPM curve, the lowest duty worth asking, the duty that starts it from
// rest, and whether it may stop. Pure: calibrate.js runs the check and hands the
// measurements over.
const Model = require('../js/airflow/airflow-model.js');
const { PUMP_FLOOR } = require('./limits.js');

// At or below this a reading is a stopped fan (some chips report a few RPM at rest).
const STOP_RPM = 60;
// A reading that drops this much when one control is lowered belongs to it.
const PAIR_DROP = 0.15;
// Across the sweep a reading must move at least this much to stay paired: a fan
// the BIOS slowed by chance while the check lowered a control does not follow the
// sweep after it. Pumps move least, about 20 % from 80 to 50 % duty.
const FOLLOW_SPAN = 0.1;
// The floor of a fan that never stops: duties whose speed is within this of the
// lowest measured one change nothing worth asking.
const KNEE = 0.03;
// Margin above the lowest duty a fan still turned at, for a fan that stops: a
// warmer or older fan stops a little higher.
const STOP_MARGIN = 5;

const isRpm = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * The readings that dropped when this control was lowered, and had not dropped for
 * an earlier one. @param {Record<string, number>} before @param {Record<string, number>} after
 * @param {Set<string>} taken readings already paired (left alone, then marked)
 */
function pairDrops(before, after, taken) {
  const out = [];
  for (const [id, was] of Object.entries(before)) {
    const now = after[id];
    if (taken.has(id) || !isRpm(was) || !isRpm(now) || was <= STOP_RPM) continue;
    if (now <= was * (1 - PAIR_DROP)) { out.push(id); taken.add(id); }
  }
  return out;
}

// Whether a reading followed the sweep: it moved enough between the highest and the
// lowest duty the fan still turned at, the right way. With one turning point there
// is nothing to compare and the pairing stands.
function follows(id, turning) {
  if (turning.length < 2) return true;
  const hi = turning[0].tachs[id];
  const lo = turning.at(-1).tachs[id];
  return isRpm(hi) && isRpm(lo) && hi > 0 && (hi - lo) / hi >= FOLLOW_SPAN;
}

const slowest = (tachs, ids) => Math.min(...ids.map((id) => (isRpm(tachs[id]) ? tachs[id] : 0)));

// Duty rising, speed never falling as duty rises (a noisy point would make the
// brain's duty for a speed ambiguous).
function curveOf(points) {
  const out = [];
  for (const [duty, rpm] of [...points].sort((a, b) => a[0] - b[0])) {
    if (out.length && duty === out.at(-1)[0]) continue;
    out.push([duty, Math.round(Math.max(rpm, out.length ? out.at(-1)[1] : 0))]);
  }
  return out.slice(-Model.MAX_CURVE);
}

// The lowest duty worth asking: above the stop for a fan that stops, and the top of
// its flat floor either way.
function minDutyOf(curve, sweep, floor) {
  // Only a point measured below full power can show a flat floor.
  let knee = 0;
  if (curve.length > 1) {
    knee = curve[0][0];
    for (const [duty, rpm] of curve) if (rpm <= curve[0][1] * (1 + KNEE)) knee = duty;
  }
  const stopped = sweep.stoppedAt != null;
  const base = stopped ? Math.min(100, (sweep.lowestTurning ?? sweep.stoppedAt) + STOP_MARGIN) : 0;
  return Math.min(100, Math.max(knee, base, floor));
}

// A control no reading followed: a fan reading on the same header that stayed put is
// a 3-pin fan on a header set to PWM; nothing there is a fan without a reading (or
// no fan). Neither is driven.
function unfollowed(ch, base, pairedElsewhere, at) {
  const guess = ch.tach;
  if (guess && !pairedElsewhere.has(guess) && isRpm(base[guess]) && base[guess] > STOP_RPM) {
    return { calib: Model.normalizeCalib({ at, hasTach: true, threePin: true, tachs: [guess], maxRpm: base[guess] }), problem: null };
  }
  return { calib: Model.normalizeCalib({ at, hasTach: false }), problem: null };
}

/**
 * @param {{ ch: { id: string, kind?: string, tach?: string|null, floor?: number },
 *   base: Record<string, number>, claimed: string[], pairedElsewhere: Set<string>,
 *   sweep: { samples: { duty: number, tachs: Record<string, number> }[], stoppedAt: number|null, lowestTurning: number|null, lost?: boolean },
 *   startDuty: number|null, at: number }} m
 * @returns {{ calib: any, problem: string|null }}
 */
function fitChannel({ ch, base, claimed, pairedElsewhere, sweep, startDuty, at }) {
  const pump = ch.kind === 'pump';
  if (sweep.lost) return { calib: null, problem: 'no-speed' };
  const turning = sweep.samples.filter((s) => s.duty !== sweep.stoppedAt);
  const kept = claimed.filter((id) => follows(id, turning));
  if (!kept.length) return unfollowed(ch, base, pairedElsewhere, at);
  // The reading on the same header first: it is the one the Fans widget shows.
  const tachs = ch.tach && kept.includes(ch.tach) ? [ch.tach, ...kept.filter((id) => id !== ch.tach)] : kept;
  const maxRpm = slowest(base, tachs);
  if (maxRpm <= STOP_RPM) return { calib: null, problem: 'no-speed' };
  if (pump && sweep.stoppedAt != null) return { calib: null, problem: 'pump-stopped' };
  const curve = curveOf([[100, maxRpm], ...turning.map((s) => [s.duty, slowest(s.tachs, tachs)])]);
  const floor = Math.max(ch.floor || 0, pump ? PUMP_FLOOR : 0);
  const minDuty = minDutyOf(curve, sweep, floor);
  const stopped = sweep.stoppedAt != null;
  if (stopped && startDuty == null) return { calib: null, problem: 'no-start' };
  const calib = Model.normalizeCalib({
    at, hasTach: true, threePin: false, tachs, maxRpm, curve, minDuty,
    startDuty: stopped ? startDuty : minDuty,
    zeroOk: stopped,
  });
  return { calib, problem: null };
}

module.exports = { fitChannel, pairDrops, STOP_RPM, PAIR_DROP, FOLLOW_SPAN, STOP_MARGIN };
