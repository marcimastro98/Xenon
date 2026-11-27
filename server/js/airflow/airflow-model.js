'use strict';

// Airflow's saved choices, one owner for the rules: the server's store (require),
// the menu card, Bit, the Deck and the tests.
//
//   { v: 1, drive: 'off'|'shadow'|'on', mode: 'auto'|'quiet'|'balanced'|'cool'|'pc',
//     slider: 0-100, options: { night: { on, from, to }, callQuiet, allowZero, linkHub, riseAlert },
//     fans: { '<driver>:<chip>:<channel>': { place, leave, pump, calib } },
//     check: { at, problems: { '<id>': 'no-start'|'no-speed'|'pump-stopped'|'no-handback'|'changed' } } | null }
//   'changed' is not the check's: a fan that turned far from its check while driven
//   (server/airflow/loop-learning.js), left to the PC until checked again.
//
// check: how the last fan check ended, for the fans it could not set up (the menu
// says why and what to do).
//
// drive: 'shadow' plans and shows what it would do, writes nothing. mode 'pc' hands
// every fan back to the PC while staying switched on (one tap back from the Deck).
// linkHub: Xenon may take a CORSAIR iCUE LINK hub (its lights go off while Xenon holds
// it, and iCUE must be closed); off by default, the hub keeps its own profile.
// riseAlert: a pop-up says why when the fans climb enough to be heard (server/airflow/rise.js).
// A fan's name is not here: it keeps the one given in the Fans widget
// (settings.fanLabels), so there is one place to rename it.
((root, factory) => {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AirflowModel = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const VERSION = 1;
  const DRIVES = Object.freeze(['off', 'shadow', 'on']);
  // Same list as server/airflow/limits.js MODE_NAMES (a test keeps them equal).
  const MODES = Object.freeze(['auto', 'quiet', 'balanced', 'cool', 'pc']);
  const PLACES = Object.freeze(['front', 'top', 'rear', 'bottom', 'side', 'radiator', 'cpu', 'gpu', 'case']);
  // '<driver>:<chip>:<channel>', lower case: 'lhm:it8689e:fan2', 'nvidia:0:fan1'.
  const ID_RE = /^[a-z0-9]{2,12}:[a-z0-9_-]{1,48}:[a-z0-9_-]{1,32}$/;
  const MAX_FANS = 32;
  const MAX_CURVE = 21;
  const MAX_AVOID = 4;
  // Speed readings one control moves: more than one behind a hub or a card's shared control.
  const MAX_TACHS = 8;
  const RPM_MAX = 10000;
  const CHECK_PROBLEMS = Object.freeze(['no-start', 'no-speed', 'pump-stopped', 'no-handback', 'changed']);

  const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
  const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
  // A whole number in [lo, hi], or the fallback for anything else (null, '', NaN).
  function int(v, lo, hi, fallback) {
    if (typeof v !== 'number' && typeof v !== 'string') return fallback;
    if (typeof v === 'string' && !v.trim()) return fallback;
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
  }
  const isFanId = (id) => typeof id === 'string' && ID_RE.test(id);

  // Duty (%) to RPM points the fan check measured, duty rising; a broken point is dropped.
  function normalizeCurve(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const p of raw.slice(0, MAX_CURVE)) {
      if (!Array.isArray(p) || p.length !== 2) continue;
      const duty = int(p[0], 0, 100, null);
      const rpm = int(p[1], 0, RPM_MAX, null);
      if (duty == null || rpm == null || (out.length && duty <= out.at(-1)[0])) continue;
      out.push([duty, rpm]);
    }
    return out;
  }

  // RPM spans that make the case hum, skipped by the brain.
  function normalizeAvoid(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const z of raw.slice(0, MAX_AVOID)) {
      if (!Array.isArray(z) || z.length !== 2) continue;
      const lo = int(z[0], 0, RPM_MAX, null);
      const hi = int(z[1], 0, RPM_MAX, null);
      if (lo != null && hi != null && lo < hi) out.push([lo, hi]);
    }
    return out;
  }

  // The speed readings the check saw follow this control, in its order (the
  // reading on the same header first).
  function normalizeTachs(raw) {
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.filter(isFanId))].slice(0, MAX_TACHS);
  }

  /** What the fan check learned about one fan, or null when it is not usable. */
  function normalizeCalib(raw) {
    if (!isObject(raw)) return null;
    const hasTach = bool(raw.hasTach, true);
    const maxRpm = int(raw.maxRpm, 1, RPM_MAX, null);
    const at = int(raw.at, 0, Number.MAX_SAFE_INTEGER, null);
    // A fan with a speed reading must have shown its top speed; one without has none to show.
    if (at == null || (hasTach && maxRpm == null)) return null;
    const minDuty = int(raw.minDuty, 0, 100, 30);
    return {
      at,
      maxRpm: hasTach ? maxRpm : null,
      tachs: hasTach ? normalizeTachs(raw.tachs) : [],
      minDuty,
      startDuty: Math.max(minDuty, int(raw.startDuty, 0, 100, minDuty)),
      zeroOk: bool(raw.zeroOk, false),
      hasTach,
      // The speed did not follow the duty: a 3-pin fan on a PWM header.
      threePin: bool(raw.threePin, false),
      // Seen back with the PC once Xenon let go (calibrate-back.js): what a beta control needs.
      handBack: bool(raw.handBack, false),
      curve: normalizeCurve(raw.curve),
      avoid: normalizeAvoid(raw.avoid),
    };
  }

  function normalizeFan(raw) {
    const v = isObject(raw) ? raw : {};
    return {
      place: PLACES.includes(v.place) ? v.place : 'case',
      // "Leave to the PC": Xenon never drives this one.
      leave: bool(v.leave, false),
      // Marked as a pump by the person (a pump found by name stays one regardless).
      pump: bool(v.pump, false),
      calib: normalizeCalib(v.calib),
    };
  }

  function normalizeCheck(raw) {
    if (!isObject(raw)) return null;
    const at = int(raw.at, 0, Number.MAX_SAFE_INTEGER, null);
    if (at == null) return null;
    const problems = {};
    for (const [id, code] of Object.entries(isObject(raw.problems) ? raw.problems : {}).slice(0, MAX_FANS)) {
      if (isFanId(id) && CHECK_PROBLEMS.includes(code)) problems[id] = code;
    }
    return { at, problems };
  }

  function normalizeNight(raw) {
    const v = isObject(raw) ? raw : {};
    return { on: bool(v.on, false), from: int(v.from, 0, 23, 23), to: int(v.to, 0, 23, 7) };
  }

  /** Any saved or sent value -> a complete, valid model. */
  function normalize(raw) {
    const v = isObject(raw) ? raw : {};
    const o = isObject(v.options) ? v.options : {};
    const fans = {};
    if (isObject(v.fans)) {
      for (const id of Object.keys(v.fans)) {
        if (Object.keys(fans).length >= MAX_FANS) break;
        if (isFanId(id)) fans[id] = normalizeFan(v.fans[id]);
      }
    }
    return {
      v: VERSION,
      drive: DRIVES.includes(v.drive) ? v.drive : 'off',
      mode: MODES.includes(v.mode) ? v.mode : 'auto',
      slider: int(v.slider, 0, 100, 50),
      options: {
        night: normalizeNight(o.night),
        callQuiet: bool(o.callQuiet, true),
        allowZero: bool(o.allowZero, false),
        linkHub: bool(o.linkHub, false),
        riseAlert: bool(o.riseAlert, true),
      },
      fans,
      check: normalizeCheck(v.check),
    };
  }

  return Object.freeze({
    VERSION, DRIVES, MODES, PLACES, ID_RE, MAX_FANS, MAX_CURVE, MAX_AVOID, MAX_TACHS, RPM_MAX, CHECK_PROBLEMS,
    normalize, normalizeFan, normalizeCalib, normalizeCheck, isFanId,
  });
});
