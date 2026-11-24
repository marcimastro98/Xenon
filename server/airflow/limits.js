'use strict';
// The numbers Airflow lives by, in one place: when cooling goes to full, what each
// comfort level aims for, and how fast a fan may change. Pure data and small
// lookups, shared by the safety layer (safety.js), the brain (brain-plan.js) and
// the tests, so a threshold is never written twice.

// Above `full` every fan Xenon drives goes to 100 % and the brain steps aside
// until the component has been `RESUME_BELOW` degrees cooler for RESUME_AFTER_MS.
// `quiet` and `cool` are the die temperatures the two ends of the comfort slider
// aim for; a target never comes closer than `margin` to `full`.
// CPU `full` depends on the chip (cpuFullAt below). GPU memory: GDDR6X/7 parts are
// rated to 105-110 °C. Hot spot: AMD junction, rated to 110 °C. Liquid: AIO pumps
// and tubing are rated around 60 °C, so 50 keeps ten degrees in hand. It was 45: in a
// warm case the liquid idles at 38-40 (its radiator breathes air already at 34), the
// ceiling of 41 sat two degrees away and an idle PC ran its radiator near full.
const COMPONENTS = Object.freeze({
  cpu: Object.freeze({ quiet: 80, cool: 66, full: null, margin: 7 }),
  gpu: Object.freeze({ quiet: 76, cool: 62, full: 83, margin: 6 }),
  gpuMem: Object.freeze({ quiet: 88, cool: 76, full: 95, margin: 6 }),
  gpuHot: Object.freeze({ quiet: 92, cool: 80, full: 100, margin: 6 }),
  liquid: Object.freeze({ quiet: 39, cool: 33, full: 50, margin: 4 }),
});

// How far over the air the slider lets the liquid sit (quiet .. cool): its comfort is the
// higher of its target and the air plus this. 10 K over the air is a quiet loop, 5-6 K a
// loud one. A warm case's radiator breathes air at about 30, and a liquid held 6 K over it
// under a light 50-60 W load ran the radiator and a case fan at 80-90 % on a CPU 13 degrees
// under its own target (24 Nov 2026).
const LIQUID_RISE = Object.freeze({ quiet: 12, cool: 6 });

const RESUME_BELOW = 10;
const RESUME_AFTER_MS = 60000;
// A sensor that has not changed its timestamp for this long, or reads outside
// SANE_TEMP, no longer steers anything.
const STALE_MS = 5000;
// A reading only late (the engine could not fetch the newer one) that the hands guard
// themselves keeps its channels at their last speed this long, then they go back too.
// Guarded: the process holding the fans reads it fresh and takes them when it gets hot
// (the Windows service, fan-hands.ps1). On a PC busy on every core the antivirus held the
// engine's read of the service's readings for up to 7.6 s (23 Nov 2026).
const LATE_OK_MS = 15000;
const SANE_TEMP = Object.freeze({ min: -20, max: 130 });
// Fan reading 0 RPM for this long while asked to turn (any duty above 0): stalled.
const STALL_MS = 5000;
// The process holding the hardware returns it to the firmware when the brain has
// been silent this long.
const LEASE_MS = 5000;
// At most one write per channel per second, never below the channel's own
// minimum, never above 100.
const WRITE_EVERY_MS = 1000;
// Pumps never go below this, whatever their calibration says.
const PUMP_FLOOR = 50;

// Comfort presets on the slider (0 = quietest, 1 = coolest).
const MODES = Object.freeze({ quiet: 0.15, balanced: 0.5, cool: 0.85 });
const MODE_NAMES = Object.freeze(['auto', 'quiet', 'balanced', 'cool', 'pc']);

// How fast the brain moves a fan, in fraction of its speed range per second:
// up gently unless heat is close, down slowly (the ear notices a fan speeding up
// far more than one slowing down), nothing smaller than the dead band, and a fall
// only once the target is downBand below: small wobbles of the plan stay unheard.
const RATE = Object.freeze({ up: 0.02, upUrgent: 0.08, down: 0.01, deadBand: 0.015, downBand: 0.05, holdAfterRiseMs: 20000 });

// Maximum junction temperature by CPU family, from the vendors' spec sheets.
// Checked in order; the first match wins. Unknown chips get a conservative 90.
/** @type {ReadonlyArray<[RegExp, number]>} */
const TJMAX = Object.freeze([
  [/Ryzen.*\b5\d{3}X3D\b/i, 90],
  [/Ryzen.*\b7\d{3}X3D\b/i, 89],
  [/Ryzen.*\b9\d{3}X3D\b/i, 95],
  [/Ryzen.*\b[79]\d{3}/i, 95],
  [/Ryzen.*\b5\d{3}/i, 90],
  [/Ryzen.*\b3\d{3}/i, 95],
  [/Core.*Ultra/i, 105],
  [/Intel/i, 100],
]);

/** @param {string} [cpuName] @returns {number} */
function tjMax(cpuName) {
  const name = String(cpuName || '');
  for (const [re, t] of TJMAX) if (re.test(name)) return t;
  return 90;
}

/** CPU temperature at which cooling goes to full. @param {string} [cpuName] */
function cpuFullAt(cpuName) {
  return tjMax(cpuName) - 5;
}

/** @param {string} component @param {string} [cpuName] @returns {number|null} */
function fullAt(component, cpuName) {
  if (component === 'cpu') return cpuFullAt(cpuName);
  const c = COMPONENTS[component];
  return c ? c.full : null;
}

const clamp01 = (x) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));

/**
 * The die temperature the brain aims for at comfort `bias` (0 quiet .. 1 cool).
 * @param {string} component @param {number} bias @param {string} [cpuName]
 * @returns {number|null}
 */
function targetFor(component, bias, cpuName) {
  const c = COMPONENTS[component];
  if (!c) return null;
  const b = clamp01(bias);
  const want = c.quiet + (c.cool - c.quiet) * b;
  const full = fullAt(component, cpuName);
  return Math.round(Math.min(want, full - c.margin) * 10) / 10;
}

/** How far over the air the liquid may sit at comfort `bias` (0 quiet .. 1 cool). @param {number} bias */
const liquidRiseFor = (bias) => LIQUID_RISE.quiet + (LIQUID_RISE.cool - LIQUID_RISE.quiet) * clamp01(bias);

/** @param {unknown} mode @param {number} slider 0..100 @returns {number} bias 0..1 */
function biasFor(mode, slider) {
  if (typeof mode === 'string' && Object.hasOwn(MODES, mode)) return MODES[mode];
  return clamp01(Number(slider) / 100);
}

const saneTemp = (v) => Number.isFinite(v) && v >= SANE_TEMP.min && v <= SANE_TEMP.max;

module.exports = {
  COMPONENTS, LIQUID_RISE, RESUME_BELOW, RESUME_AFTER_MS, STALE_MS, LATE_OK_MS, SANE_TEMP, STALL_MS, LEASE_MS,
  WRITE_EVERY_MS, PUMP_FLOOR, MODES, MODE_NAMES, RATE,
  tjMax, cpuFullAt, fullAt, targetFor, liquidRiseFor, biasFor, saneTemp, clamp01,
};
