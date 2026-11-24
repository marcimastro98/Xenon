'use strict';
// How the cooling ages. Two slow signs, read from what the brain already knows:
//   wear: a fan turning slower than its check said it would at the same duty;
//   dust: the same heat, at the same fan speeds, settling warmer than it did. The
//         brain keeps learning, so its models drift as filters clog: once a day the
//         rise over ambient at a fixed reference (every fan at half, a set power)
//         is noted, and compared with the best weeks.
// After "I cleaned the filters" the next readings are compared with the last ones
// before, so Xenon can say what the cleaning bought.
const { rpmAt } = require('./inventory.js');

// A fan's reading counts only once its duty has held this long (the fan has settled).
const STEADY_MS = 30000;
// Each settled reading moves the fan's ratio this much: about an hour of readings.
const WEAR_RATE = 1 / 3600;
const WEAR_MIN_SAMPLES = 600;
const WEAR_SLOW = 0.85;
const REF = Object.freeze({ fraction: 0.5, ambient: 25, power: Object.freeze({ cpu: 100, gpu: 250 }) });
// A day's reading needs a model this sure of itself.
const MIN_CONFIDENCE = 0.6;
const HISTORY_DAYS = 120;
const BASELINE_DAYS = 14;
const DUST_WARMER = 0.15;
const DUST_DAYS = 3;
const AFTER_CLEANING_DAYS = 3;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function loadWear(raw) {
  const out = {};
  for (const [id, w] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (w && finite(w.ratio) && w.ratio > 0 && w.ratio < 3 && Number.isInteger(w.n) && w.n >= 0) out[id] = { ratio: w.ratio, n: w.n };
  }
  return out;
}

function loadHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((d) => d && DAY_RE.test(d.day) && (d.cpu == null || finite(d.cpu)) && (d.gpu == null || finite(d.gpu))).slice(-HISTORY_DAYS);
}

/** @param {{ saved?: any }} [opts] */
function createHealth({ saved = {} } = {}) {
  const wear = loadWear(saved?.wear);
  let history = loadHistory(saved?.history);
  let cleaned = typeof saved?.cleaned === 'string' && DAY_RE.test(saved.cleaned) ? saved.cleaned : null;
  const held = new Map();

  /** One tick for one driven fan: duty now, rpm read, its checked curve. */
  function observeFan({ id, duty, rpm, curve, now }) {
    const h = held.get(id);
    if (!h || h.duty !== duty) { held.set(id, { duty, since: now }); return; }
    const expected = rpmAt(curve || [], duty);
    if (now - h.since < STEADY_MS || !finite(rpm) || !(expected > 0) || rpm <= 0) return;
    const w = wear[id] || { ratio: 0, n: 0 };
    // A plain average at first, then a moving one about an hour long.
    w.n += 1;
    w.ratio += (rpm / expected - w.ratio) * Math.max(WEAR_RATE, 1 / w.n);
    wear[id] = w;
  }

  /** Once a day: the rise over ambient each confident model expects at the reference. */
  function daily({ day, models }) {
    if (!DAY_RE.test(day) || history.at(-1)?.day === day) return;
    const entry = { day, cpu: null, gpu: null };
    for (const node of ['cpu', 'gpu']) {
      const m = models?.[node];
      if (!m || m.confidence() < MIN_CONFIDENCE) continue;
      const mix = Object.fromEntries(m.ids.map((id) => [id, REF.fraction]));
      entry[node] = m.steady(mix, REF.power[node], REF.ambient) - REF.ambient;
    }
    if (entry.cpu == null && entry.gpu == null) return;
    history = [...history, entry].slice(-HISTORY_DAYS);
  }

  const values = (days, node) => days.map((d) => d[node]).filter(finite);
  const mean = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);

  // The coolest BASELINE_DAYS in a row: the cooling at its cleanest.
  function bestStretch(xs) {
    let best = Infinity;
    for (let i = 0; i + BASELINE_DAYS <= xs.length; i += 1) best = Math.min(best, mean(xs.slice(i, i + BASELINE_DAYS)));
    return best;
  }

  // Warmer than the best stretch by DUST_WARMER on each of the last DUST_DAYS days.
  function dustOf(node) {
    const since = cleaned ? history.filter((d) => d.day > cleaned) : history;
    const xs = values(since, node);
    if (xs.length < BASELINE_DAYS + DUST_DAYS) return null;
    const base = bestStretch(xs.slice(0, -DUST_DAYS));
    const recent = xs.slice(-DUST_DAYS);
    const warmer = Math.min(...recent.map((x) => x / base - 1));
    return { warmer, dusty: warmer >= DUST_WARMER };
  }

  // Degrees the cleaning bought at the reference: the days before against the days after.
  function cleaningGain(node) {
    if (!cleaned) return null;
    const before = mean(values(history.filter((d) => d.day <= cleaned).slice(-AFTER_CLEANING_DAYS), node));
    const after = values(history.filter((d) => d.day > cleaned), node);
    if (before == null || after.length < AFTER_CLEANING_DAYS) return null;
    return before - mean(after.slice(0, AFTER_CLEANING_DAYS));
  }

  function report() {
    const slow = Object.entries(wear).filter(([, w]) => w.n >= WEAR_MIN_SAMPLES && w.ratio < WEAR_SLOW).map(([id, w]) => ({ id, ratio: w.ratio }));
    return {
      slow,
      dust: { cpu: dustOf('cpu'), gpu: dustOf('gpu') },
      cleaned,
      gain: { cpu: cleaningGain('cpu'), gpu: cleaningGain('gpu') },
    };
  }

  return {
    observeFan,
    daily,
    report,
    cleanedOn(day) { if (DAY_RE.test(day)) cleaned = day; },
    // A fan checked again starts from its new curve.
    forgetFan(id) { delete wear[id]; held.delete(id); },
    save: () => ({ wear: structuredClone(wear), history: [...history], cleaned }),
  };
}

module.exports = { createHealth, STEADY_MS, WEAR_SLOW, WEAR_MIN_SAMPLES, DUST_WARMER, DUST_DAYS, BASELINE_DAYS, AFTER_CLEANING_DAYS, REF };
