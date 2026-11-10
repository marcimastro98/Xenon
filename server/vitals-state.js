'use strict';
// Vitals state (vitals.state): what the meters and Bit remember, written by the
// widget on every surface. Two doors write it: the whole-blob POST /settings
// from the dashboard, and POST /api/vitals/state from a layer page, whose
// settings are read-only (js/settings.js _settingsReadOnly), so a refill or a
// truce tapped there was lost. Both go through mergeState, so a stale surface
// can never rewind what another one saved. The settings normaliser
// (normalizeVitals) re-clamps the result on write.

const vitalsPetCore = require('./js/vitals-pet-core');

const MAX_BYTES = 32 * 1024;
const STATE_KEYS = Object.freeze(['last', 'xp', 'day', 'fills', 'log', 'awayCreditAt', 'pet', 'mem']);

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Monotonic merge: a refill stamps "now", XP only grows, the daily counter
// resets on a new day. Keep the newest per-vital timestamp, the highest XP and
// the most recent day's counter and ribbon.
function mergeState(prevState, inState) {
  const prev = isPlain(prevState) ? prevState : {};
  const inc = isPlain(inState) ? inState : {};
  const inLast = isPlain(inc.last) ? inc.last : {};
  const prevLast = isPlain(prev.last) ? prev.last : {};
  const last = { ...inLast };
  for (const id of Object.keys(prevLast)) {
    if ((Number(prevLast[id]) || 0) > (Number(last[id]) || 0)) last[id] = prevLast[id];
  }
  let day = typeof inc.day === 'string' ? inc.day : '';
  let fills = Number(inc.fills) || 0;
  let log = Array.isArray(inc.log) ? inc.log : [];
  const prevDay = typeof prev.day === 'string' ? prev.day : '';
  const prevLog = Array.isArray(prev.log) ? prev.log : [];
  if (prevDay > day) { day = prevDay; fills = Number(prev.fills) || 0; log = prevLog; } // YYYY-MM-DD sorts lexicographically
  else if (prevDay === day) {
    fills = Math.max(fills, Number(prev.fills) || 0);
    // Refills only append within a day — the longer ribbon is the newer one.
    if (prevLog.length > log.length) log = prevLog;
  }
  return {
    ...inc,
    last,
    xp: Math.max(Number(prev.xp) || 0, Number(inc.xp) || 0),
    day,
    fills,
    log,
    // Away-pause credit marker: freezeStart of the last credited away
    // period — forward-only, so a stale surface can't re-credit a
    // period another surface already applied (vitals-pet-core.awayCredit).
    awayCreditAt: Math.max(Number(prev.awayCreditAt) || 0, Number(inc.awayCreditAt) || 0),
    // Bit's durable bookkeeping + long-term memory: merged (never
    // last-writer-wins) so a truce/escalation flag set on one surface
    // holds on the other and lifetime counters only grow.
    pet: vitalsPetCore.mergePetBookkeeping(prev.pet, inc.pet),
    mem: vitalsPetCore.mergeVitalsMem(prev.mem, inc.mem),
  };
}

// POST /api/vitals/state body → { state } or { error }. Only the state keys:
// the opt-ins (vitals.pet, items) stay on the Settings door.
function plan(body) {
  const state = body && body.state;
  if (!isPlain(state)) return { error: 'bad_state' };
  if (JSON.stringify(state).length > MAX_BYTES) return { error: 'too_large' };
  const extra = Object.keys(state).find((k) => !STATE_KEYS.includes(k));
  if (extra) return { error: 'not_allowed', field: extra };
  return { state };
}

module.exports = { STATE_KEYS, mergeState, plan };
