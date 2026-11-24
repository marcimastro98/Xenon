'use strict';
// Every fan and pump Airflow can see, as one list the brain and the safety layer
// share: what each driver found, joined with what the person chose (place, "leave
// to the PC"), what the fan check measured, and the name given in the Fans widget.
// Pure: the drivers read the hardware, the store keeps the choices.
const Model = require('../js/airflow/airflow-model.js');

/**
 * What a driver reports for one channel.
 * @typedef {{ id: string, name: string, labelKey?: string, kind?: 'fan'|'pump', source: 'mb'|'gpu'|'hub',
 *   controllable: boolean, zeroByDefault?: boolean, rpm?: number|null, duty?: number|null, tach?: string|null,
 *   place?: string, beta?: boolean }} Found (place: the driver's own guess, e.g. an AIO kit's fans on the radiator;
 *   beta: a control Xenon never tried on real hardware, driven only once the check saw it go back)
 */

const PUMP_RE = /pump/i;
const CPU_RE = /\bcpu|cpu_?(fan|opt)/i;

/** A stable channel id from a driver's own names: '<driver>:<chip>:<channel>', lower case. */
function fanId(driver, chip, channel) {
  const part = (s, max) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max);
  const id = `${part(driver, 12)}:${part(chip, 48)}:${part(channel, 32)}`;
  return Model.isFanId(id) ? id : null;
}

/**
 * The sensors a channel cools: the ones whose loss hands it back to the PC
 * (safety.js). A sensor this PC never had is skipped there, so a radiator on a
 * board without a liquid reading depends on the CPU alone.
 */
function depsFor(place, kind = 'fan') {
  if (kind === 'pump' || place === 'radiator' || place === 'cpu') return ['cpu', 'liquid'];
  if (place === 'gpu') return ['gpu', 'gpuMem'];
  return ['cpu', 'gpu'];
}

// Where a fan sits before the person says: what its driver knows, the card's own
// fans, a header named for the CPU, or somewhere in the case.
function guessPlace(f) {
  if (Model.PLACES.includes(f.place)) return f.place;
  if (f.source === 'gpu') return 'gpu';
  return CPU_RE.test(f.name) ? 'cpu' : 'case';
}

// RPM at a duty on the measured curve (linear between points).
function rpmAt(curve, duty) {
  if (!curve.length) return null;
  if (duty <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i += 1) {
    const [d1, r1] = curve[i];
    const [d0, r0] = curve[i - 1];
    if (duty <= d1) return r0 + ((r1 - r0) * (duty - d0)) / (d1 - d0);
  }
  return curve.at(-1)[1];
}

// The speed a channel shows: the slowest of the readings the check paired with it
// (any one stopping is a stall), or the driver's guess from the same header before
// a check. A paired reading gone missing is left out, never read as a stall: a LINK
// pump also read on the board's CPU_FAN header keeps its own reading when the
// board's sensors stop. Unknown only when none is left.
function rpmOf(f, calib, tachs) {
  if (!calib?.tachs?.length) return Number.isFinite(f.rpm) ? f.rpm : null;
  const v = calib.tachs.map((id) => tachs?.[id]).filter(Number.isFinite);
  return v.length ? Math.min(...v) : null;
}

// Why Xenon does not drive a channel it can see, or null when it does.
function notDrivenWhy(f, prefs) {
  if (!f.controllable) return 'readonly';
  if (prefs.leave) return 'leave';
  if (!prefs.calib) return 'unchecked';
  if (prefs.calib.threePin) return 'three-pin';
  // Without a speed reading a stopped fan or pump would go unseen.
  if (!prefs.calib.hasTach) return 'blind';
  // A control Xenon never tried on real hardware: only once the check saw it go back to the PC.
  if (f.beta === true && prefs.calib.handBack !== true) return 'unproven';
  return null;
}

function channelOf(f, prefs, labels, tachs) {
  const place = prefs.place;
  const name = (f.labelKey && labels[f.labelKey]) || f.name;
  // The name the person gave it counts too: a header they called 'pump' is one, never stopped.
  // pumpBy says which: the device (its kind or its own name), the name, or only the person's
  // mark, the one reason the menu lets them take back.
  const pumpBy = f.kind === 'pump' || PUMP_RE.test(f.name) ? 'device' : PUMP_RE.test(name) ? 'name' : prefs.pump ? 'person' : null;
  const kind = pumpBy ? 'pump' : 'fan';
  const why = notDrivenWhy(f, prefs);
  const c = prefs.calib;
  const minFrac = c?.maxRpm ? Math.min(1, (rpmAt(c.curve, c.minDuty) ?? c.maxRpm * (c.minDuty / 100)) / c.maxRpm) : null;
  return {
    id: f.id,
    name,
    // Renamed in the Fans widget: the menu then shows that name, never its own words.
    named: !!(f.labelKey && labels[f.labelKey]),
    kind,
    pumpBy,
    place,
    source: f.source,
    beta: f.beta === true,
    controllable: why == null,
    why,
    hasTach: c ? c.hasTach : Number.isFinite(f.rpm),
    maxRpm: c?.maxRpm ?? null,
    minDuty: c?.minDuty ?? null,
    startDuty: c?.startDuty ?? null,
    minFrac,
    curve: c?.curve ?? [],
    avoid: c?.avoid ?? [],
    // A card's fan stops by being handed back to the card (driver-lhm.js), even when
    // the check never saw it stop: its control does not go under its minimum.
    zeroOk: (c?.zeroOk === true || f.zeroByDefault === true) && kind !== 'pump',
    zeroByDefault: f.zeroByDefault === true && kind !== 'pump',
    deps: depsFor(place, kind),
    rpm: rpmOf(f, c, tachs),
    duty: Number.isFinite(f.duty) ? f.duty : null,
  };
}

/**
 * @param {{ found: Found[], model: any, labels?: Record<string, string>, tachs?: Record<string, number|null> }} input
 * @returns {any[]} one channel per valid, distinct id, in the drivers' order
 */
function buildInventory({ found, model, labels = {}, tachs = {} }) {
  const m = Model.normalize(model);
  const out = [];
  const ids = new Set();
  for (const f of Array.isArray(found) ? found : []) {
    if (!f || !Model.isFanId(f.id) || ids.has(f.id) || typeof f.name !== 'string') continue;
    ids.add(f.id);
    // A fan the person never touched has no saved entry: its place is guessed.
    const prefs = m.fans[f.id] || { ...Model.normalizeFan({}), place: guessPlace(f) };
    out.push(channelOf(f, prefs, labels, tachs));
  }
  return out;
}

module.exports = { buildInventory, fanId, depsFor, rpmAt };
