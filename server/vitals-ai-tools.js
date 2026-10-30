'use strict';
// Bit's Vitals tools (server.js executeAiTool): read the meters, mark one done
// because the user just said they did it, and switch Vitals / the pet / the
// truce / the tone. The math is the dashboard's own (js/vitals-core.js), and
// every write goes through the caller's locked settings update, so a refill
// said to Bit lands exactly like a tap on the bar.
//
// deps (injected):
//   read     () → current hub settings (no lock, for reads)
//   update   async (fn) → saved settings; fn(cur) returns the next settings or
//            null for "nothing to write". Runs under withHubSettingsLock.
//   now      clock, for tests
const VitalsCore = require('./js/vitals-core');

const NAMES = Object.freeze(['get_vitals', 'refill_vital', 'set_vitals']);
const TONES = Object.freeze(['soft', 'spicy', 'savage']);
const PAUSES = Object.freeze(['snooze', 'today', 'resume']);

const FUNCTIONS = Object.freeze([
  { name: 'get_vitals', description: 'Read the user\'s Vitals self-care meters (hydration, energy, stamina = stretch or walk, focus = a break from the screen, posture): how full each one is, how many minutes until it runs out, today\'s refills, the self-care level and the daily streak, and whether Bit\'s nagging is paused. Use for "how am I doing", "when should I drink", "what\'s my streak".', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'refill_vital', description: 'Mark a Vitals meter as done because the user just told you they did it: drank water = hydration, ate or rested = energy, stretched or walked = stamina, looked away from the screen or took a break = focus, sat up straight = posture. "all" refills every meter that is on. Only when the user says they did it, never on your own.', parameters: { type: 'OBJECT', properties: {
    vital: { type: 'STRING', description: 'One of: hydration, energy, stamina, focus, posture, all' },
  }, required: ['vital'] } },
  { name: 'set_vitals', description: 'Change Vitals: turn the meters on or off, turn Bit the pet (the little guardian that reacts when a meter hits zero) on or off, pause its nagging (snooze = 30 minutes, today = until midnight, resume = lift the pause), set its tone (soft, spicy, savage), choose the hours Bit sleeps (quietFrom to quietTo, whole hours 0 to 23, e.g. 18 to 9 keeps it quiet outside work), or turn natural breaks on or off (time away from the PC refills stamina and focus). Pass only what the user asked to change.', parameters: { type: 'OBJECT', properties: {
    enabled: { type: 'BOOLEAN', description: 'Vitals meters on or off' },
    pet: { type: 'BOOLEAN', description: 'Bit the pet on or off' },
    pause: { type: 'STRING', description: 'One of: snooze, today, resume' },
    tone: { type: 'STRING', description: 'One of: soft, spicy, savage' },
    quietFrom: { type: 'INTEGER', description: 'Hour Bit starts sleeping, 0 to 23' },
    quietTo: { type: 'INTEGER', description: 'Hour Bit wakes up, 0 to 23' },
    naturalBreaks: { type: 'BOOLEAN', description: 'Time away from the PC refills stamina and focus' },
  } } },
]);

function vitalsOf(settings) {
  return settings && settings.vitals && typeof settings.vitals === 'object' ? settings.vitals : {};
}

function pauseInfo(v, now) {
  const p = (v.state && v.state.pet) || {};
  const until = Number(p.snoozeUntil) || 0;
  return {
    snoozedMinutes: until > now ? Math.ceil((until - now) / 60000) : 0,
    quietToday: p.muteDay === VitalsCore.dayKey(new Date(now)),
  };
}

const isHour = (h) => Number.isInteger(h) && h >= 0 && h <= 23;
const hourOr = (h, fallback) => (isHour(h) ? h : fallback);

function read(settings, now) {
  const v = vitalsOf(settings);
  const pet = v.pet || {};
  const quiet = pet.nightQuiet !== false ? { quietFrom: hourOr(pet.quietFrom, 23), quietTo: hourOr(pet.quietTo, 7) } : { quietFrom: null, quietTo: null };
  return { ...VitalsCore.snapshot(v, now), naturalBreaks: v.naturalBreaks !== false, pet: { on: pet.enabled === true, tone: pet.tone || 'spicy', ...quiet, ...pauseInfo(v, now) } };
}

function onIds(v) {
  return VitalsCore.IDS.filter((id) => v.items && v.items[id] && v.items[id].on !== false);
}

function withVitals(cur, v) {
  return { ...cur, vitals: v };
}

function refill(cur, wanted, now) {
  let v = vitalsOf(cur);
  if (v.enabled === false) return { error: 'vitals_off' };
  const ids = wanted === 'all' ? onIds(v) : [wanted];
  if (!ids.length || !ids.every((id) => onIds(v).includes(id))) return { error: 'vital_off' };
  let streakUp = 0;
  let levelUp = 0;
  for (const id of ids) {
    const r = VitalsCore.refillPatch(v, id, now);
    v = { ...v, state: { ...(v.state || {}), ...r.patch } };
    streakUp = r.streakUp || streakUp;
    levelUp = r.levelUp || levelUp;
  }
  return { next: withVitals(cur, v), refilled: ids, streakUp, levelUp };
}

function change(cur, args, now) {
  const v = vitalsOf(cur);
  let next = v;
  if (typeof args.enabled === 'boolean') next = { ...next, enabled: args.enabled };
  if (typeof args.pet === 'boolean') next = { ...next, pet: { ...(next.pet || {}), enabled: args.pet } };
  if (args.tone != null) next = { ...next, pet: { ...(next.pet || {}), tone: args.tone } };
  // Choosing the hours also turns the quiet hours on, or the choice would do nothing.
  for (const k of ['quietFrom', 'quietTo']) if (args[k] != null) next = { ...next, pet: { ...(next.pet || {}), [k]: args[k], nightQuiet: true } };
  if (typeof args.naturalBreaks === 'boolean') next = { ...next, naturalBreaks: args.naturalBreaks };
  if (args.pause != null) {
    const truce = VitalsCore.truce(next.state && next.state.pet, args.pause, now);
    next = { ...next, state: { ...(next.state || {}), pet: truce } };
  }
  return next === v ? null : withVitals(cur, next);
}

function badArgs(args) {
  if (args.pause != null && !PAUSES.includes(args.pause)) return 'pause: snooze, today or resume';
  if (args.tone != null && !TONES.includes(args.tone)) return 'tone: soft, spicy or savage';
  for (const k of ['quietFrom', 'quietTo']) if (args[k] != null && !isHour(args[k])) return k + ': a whole hour from 0 to 23';
  return '';
}

// → the tool result Bit reads.
async function run(fnName, fnArgs, { read: readSettings, update, now = Date.now } = {}) {
  const args = fnArgs && typeof fnArgs === 'object' ? fnArgs : {};
  const t = now();
  if (fnName === 'get_vitals') return read(readSettings(), t);
  if (fnName === 'refill_vital') {
    const wanted = String(args.vital || '').toLowerCase();
    if (wanted !== 'all' && !VitalsCore.IDS.includes(wanted)) return { ok: false, error: 'bad_args', hint: 'vital: hydration, energy, stamina, focus, posture or all.' };
    let out = null;
    const saved = await update((cur) => {
      out = refill(cur, wanted, t);
      return out.next || null;
    });
    if (out.error === 'vitals_off') return { ok: false, error: 'vitals_off', hint: 'Vitals is off. Ask if they want it on (set_vitals enabled).' };
    if (out.error) return { ok: false, error: 'vital_off', hint: 'That meter is not on in Settings, Bit.' };
    return { ok: true, refilled: out.refilled, streakUp: out.streakUp, levelUp: out.levelUp, now: read(saved, t) };
  }
  if (fnName === 'set_vitals') {
    const bad = badArgs(args);
    if (bad) return { ok: false, error: 'bad_args', hint: bad };
    const saved = await update((cur) => change(cur, args, t));
    return { ok: true, now: read(saved, t) };
  }
  return { ok: false, error: 'unknown_tool' };
}

module.exports = { NAMES, FUNCTIONS, run, read };
