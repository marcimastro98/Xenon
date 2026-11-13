// The fixed lists the Vitals settings are checked against: the meters, their defaults and the
// steps of the pet's reaction.

// Vitals — game-style self-care meters. Known-key rebuild, identical to the
// client normalizer (settings.js): per-vital enable + interval, plus the
// client-owned state (last-refill timestamps, XP, daily fill counter).
const VITALS_IDS = Object.freeze(['hydration', 'energy', 'stamina', 'focus', 'posture']);
const VITALS_DEFAULT_MIN = Object.freeze({ hydration: 45, energy: 180, stamina: 60, focus: 25, posture: 45 });
const VITALS_DEFAULT_ON = Object.freeze({ hydration: true, energy: true, stamina: true, focus: true, posture: false });
// Bit's escalation ladder — minutes at zero before each rung (mirror of the
// client VITALS_PET_DEFAULT_THR / core.STAGE_AT; user-tunable in Settings → Bit).
const VITALS_PET_STAGES = Object.freeze(['decay', 'gameover', 'overlay', 'minimize', 'lock']);
const VITALS_PET_DEFAULT_THR = Object.freeze({ decay: 5, gameover: 8, overlay: 10, minimize: 15, lock: 20 });
function vitalsHour(h) { return Number.isInteger(h) && h >= 0 && h <= 23; }

module.exports = {
  VITALS_IDS, VITALS_DEFAULT_MIN, VITALS_DEFAULT_ON, VITALS_PET_STAGES, VITALS_PET_DEFAULT_THR,
  vitalsHour,
};
