// Checks the Vitals settings (the reminders and Bit, the guardian pet): every field brought
// back to an allowed value or its default.

const { clampNumber } = require('../settings/values.js');
const {
  VITALS_IDS, VITALS_DEFAULT_MIN, VITALS_DEFAULT_ON, VITALS_PET_STAGES, VITALS_PET_DEFAULT_THR,
  vitalsHour,
} = require('./settings-values.js');
const { cleanRoastSparksCap } = require('../vitals-roast-sparks.js');

function normalizeVitals(value) {
  const v = value && typeof value === 'object' ? value : {};
  const itemsSrc = v.items && typeof v.items === 'object' ? v.items : {};
  const stateSrc = v.state && typeof v.state === 'object' ? v.state : {};
  const lastSrc = stateSrc.last && typeof stateSrc.last === 'object' ? stateSrc.last : {};
  const items = {};
  const last = {};
  VITALS_IDS.forEach((id) => {
    const it = itemsSrc[id] && typeof itemsSrc[id] === 'object' ? itemsSrc[id] : {};
    items[id] = {
      on: typeof it.on === 'boolean' ? it.on : VITALS_DEFAULT_ON[id],
      min: Math.round(clampNumber(it.min, 5, 480, VITALS_DEFAULT_MIN[id])),
    };
    const ts = Number(lastSrc[id]);
    last[id] = Number.isFinite(ts) && ts > 0 ? Math.floor(ts) : 0;
  });
  // Bit, the pixel guardian pet. Each rung of the nag ladder is strict opt-in:
  // the PC-invading actions (monitor popups, minimize-all, workstation lock)
  // require `=== true` — the /api/vitals/nag endpoint enforces these
  // server-side, so a forged client request can never act beyond the opt-ins.
  const petSrc = v.pet && typeof v.pet === 'object' ? v.pet : {};
  const thrSrc = petSrc.thresholds && typeof petSrc.thresholds === 'object' ? petSrc.thresholds : {};
  const thresholds = {};
  VITALS_PET_STAGES.forEach((stage) => {
    thresholds[stage] = Math.round(clampNumber(thrSrc[stage], 1, 480, VITALS_PET_DEFAULT_THR[stage]));
  });
  const pet = {
    enabled: petSrc.enabled === true,
    tone: ['soft', 'spicy', 'savage'].includes(petSrc.tone) ? petSrc.tone : 'spicy',
    effects: petSrc.effects !== false,
    sounds: petSrc.sounds !== false,
    lighting: petSrc.lighting === true,
    monitors: petSrc.monitors === true,
    minimize: petSrc.minimize === true,
    lock: petSrc.lock === true,
    quietInGame: petSrc.quietInGame !== false,
    // Where Bit lives: the floating corner sprite, a mini chip in the topbar
    // clock cluster, or both. AI roasts (Xenon AI-generated lines with offline
    // bank fallback) are strict opt-in; night quiet (23–07: Bit sleeps, never
    // escalates past decay) is on by default.
    position: ['floating', 'topbar', 'both'].includes(petSrc.position) ? petSrc.position : 'floating',
    aiRoasts: petSrc.aiRoasts === true,
    // With Sparks as the AI, the Sparks a day the roasts may spend (0 = never).
    roastSparksCap: cleanRoastSparksCap(petSrc.roastSparksCap),
    nightQuiet: petSrc.nightQuiet !== false,
    // The quiet window, whole local hours: from (inclusive) to (exclusive),
    // wrapping past midnight when from > to; from === to means no quiet hours.
    // Anything but an hour 0-23 reads as the default (null is not midnight).
    quietFrom: vitalsHour(petSrc.quietFrom) ? petSrc.quietFrom : 23,
    quietTo: vitalsHour(petSrc.quietTo) ? petSrc.quietTo : 7,
    thresholds,
  };
  // Bit's durable bookkeeping (state.pet): truce (snooze/mute-today) and the
  // per-episode escalation flags, persisted so a reload can't re-fire GAME
  // OVER/minimize/lock and a truce granted on one surface holds on the others.
  // Episodes are keyed by z = the episode's zeroAt instant (a stable identity
  // across reloads and surfaces). Known-key rebuild — never spread.
  const petStSrc = stateSrc.pet && typeof stateSrc.pet === 'object' ? stateSrc.pet : {};
  const epSrc = petStSrc.ep && typeof petStSrc.ep === 'object' ? petStSrc.ep : {};
  const ep = {};
  VITALS_IDS.forEach((id) => {
    const e = epSrc[id];
    if (!e || typeof e !== 'object') return;
    const z = Number(e.z);
    if (!Number.isFinite(z) || z <= 0) return;
    ep[id] = {
      z: Math.floor(z),
      goAt: Math.max(0, Math.floor(Number(e.goAt) || 0)),
      ovAt: Math.max(0, Math.floor(Number(e.ovAt) || 0)),
      min: e.min === true,
      lock: e.lock === true,
    };
  });
  const statePet = {
    snoozeUntil: Math.round(clampNumber(petStSrc.snoozeUntil, 0, Date.now() + 24 * 3600000, 0)),
    muteDay: typeof petStSrc.muteDay === 'string' ? petStSrc.muteDay.slice(0, 10) : '',
    ep,
  };
  // Bit's long-term memory: daily self-care streak + grow-only lifetime
  // counters (fuel for contextual/AI roasts and streak praise).
  const memSrc = stateSrc.mem && typeof stateSrc.mem === 'object' ? stateSrc.mem : {};
  const mem = {
    streak: Math.round(clampNumber(memSrc.streak, 0, 100000, 0)),
    bestStreak: Math.round(clampNumber(memSrc.bestStreak, 0, 100000, 0)),
    lastFillDay: typeof memSrc.lastFillDay === 'string' ? memSrc.lastFillDay.slice(0, 10) : '',
    locksTotal: Math.round(clampNumber(memSrc.locksTotal, 0, 1e6, 0)),
    gameoversTotal: Math.round(clampNumber(memSrc.gameoversTotal, 0, 1e6, 0)),
  };
  return {
    enabled: v.enabled !== false,
    topbar: v.topbar === true,
    reminders: v.reminders !== false,
    // Freeze the meters while the user is away from the PC (no real input for
    // 5+ min, via the server idle probe) and resume exactly where they were.
    awayPause: v.awayPause !== false,
    naturalBreaks: v.naturalBreaks !== false,
    pet,
    items,
    state: {
      last,
      xp: Math.round(clampNumber(stateSrc.xp, 0, 1e9, 0)),
      day: typeof stateSrc.day === 'string' ? stateSrc.day.slice(0, 10) : '',
      fills: Math.round(clampNumber(stateSrc.fills, 0, 100000, 0)),
      // Today's refills in order (the widget's "combo ribbon"); bounded.
      log: Array.isArray(stateSrc.log) ? stateSrc.log.filter(x => VITALS_IDS.includes(x)).slice(-40) : [],
      // freezeStart identity of the last credited away period (see
      // vitals-pet-core.awayCredit) — merged as max server-side.
      awayCreditAt: Math.max(0, Math.floor(Number(stateSrc.awayCreditAt) || 0)),
      pet: statePet,
      mem,
    },
  };
}

module.exports = { normalizeVitals };
