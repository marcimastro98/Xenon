'use strict';
// Turns the planner's target speeds into the duty values written to the fans,
// moving them in ways the ear does not catch:
//   - up gently (fast only when heat is close), down slowly, nothing inside the
//     dead band, and no fall for a while after a rise (no up-down-up hunting);
//   - a fan allowed to stop does so only after a minute of not being needed, so it
//     never starts and stops every few seconds;
//   - speed is set in RPM through the fan's own calibrated curve, and fans of one
//     beat group are trimmed on their tachometers until they really turn alike
//     (two identical fans at the same duty can be 50 RPM apart; that is a beat).
const L = require('./limits.js');
const { groupsOf } = require('./brain-plan.js');

const STOP_AFTER_MS = 60000;
const TRIM_GAIN = 0.05;     // duty points per second per percent of RPM error
const TRIM_MAX = 12;        // duty points
const TRIM_SETTLED = 0.01;  // the target must be this still before trimming
// A fan starting from standstill is pushed: many keep turning at a duty they cannot
// start from, and the start duty the fan check found was met by a fan already
// stirring, so the push goes KICK_EXTRA over it. It lasts until the tachometer sees
// the fan turn, never under KICK_MIN_MS (a command and its reading each take a second
// or two through the sensor service), at most KICK_MS: by then the safety layer has
// called it a stall (23 Nov 2026: three seconds at the bare start duty, then the
// minimum, left a case fan still and handed back to the BIOS).
const KICK_EXTRA = 10;
const KICK_MIN_MS = 2500;
const KICK_MS = L.STALL_MS;
const KICK_BLIND_MS = 3000; // a fan without a tachometer: pushed for this long

/**
 * Duty that gives `rpm` on this fan, from its calibration points [[duty, rpm]...];
 * without a curve, speed is taken as proportional to duty.
 */
function dutyFor(ch, frac) {
  const max = ch.maxRpm || 0;
  const curve = Array.isArray(ch.curve) ? ch.curve.filter((p) => p[1] > 0).sort((a, b) => a[0] - b[0]) : [];
  if (!max || curve.length < 2) return frac * 100;
  const rpm = frac * max;
  if (rpm <= curve[0][1]) return curve[0][0];
  for (let i = 1; i < curve.length; i += 1) {
    const [d0, r0] = curve[i - 1];
    const [d1, r1] = curve[i];
    if (rpm <= r1) return r1 === r0 ? d1 : d0 + ((rpm - r0) / (r1 - r0)) * (d1 - d0);
  }
  return 100;
}

function createSmoother() {
  /** @type {Map<string, { frac: number, blind: boolean, riseAt: number, zeroSince: number, trim: number, lastTarget: number, kickFrom: number, kickUntil: number, falling: boolean }>} */
  const state = new Map();

  function moveToward(s, target, now, dtS, urgent, calm) {
    const diff = target - s.frac;
    if (target !== 0 && (diff > 0 ? diff < L.RATE.deadBand : -diff < L.RATE.downBand && !s.falling)) return;
    // Once a fall starts it goes all the way to the target, not just to the band.
    s.falling = diff < 0;
    if (diff > 0) {
      const up = urgent ? L.RATE.upUrgent : calm ? L.RATE.up / 2 : L.RATE.up;
      s.frac = Math.min(target, s.frac + up * dtS);
      s.riseAt = now;
    } else if (now - s.riseAt >= L.RATE.holdAfterRiseMs) {
      s.frac = Math.max(target, s.frac - L.RATE.down * dtS);
    }
  }

  // raw: the duty the curve gives; floor: the lowest duty the fan runs at. The
  // trim stops growing against a limit it cannot pass (no wind-up).
  function trimFor(ch, s, groupTarget, measured, dtS, raw, floor) {
    const rpm = measured?.[ch.id];
    if (!Number.isFinite(rpm) || !(rpm > 0) || !ch.maxRpm || Math.abs(s.lastTarget - groupTarget) > TRIM_SETTLED) {
      s.lastTarget = groupTarget;
      return;
    }
    const err = ((groupTarget * ch.maxRpm - rpm) / ch.maxRpm) * 100;
    if ((err < 0 && raw + s.trim <= floor) || (err > 0 && raw + s.trim >= 100)) return;
    s.trim = Math.max(-TRIM_MAX, Math.min(TRIM_MAX, s.trim + TRIM_GAIN * err * dtS));
  }

  /**
   * @param {{ now: number, dtMs: number, channels: any[], fractions: Record<string, number>,
   *   urgent?: boolean, calm?: boolean, measured?: Record<string, number>, pumpFraction?: number }} input
   * @returns {{ duties: Record<string, number>, fractions: Record<string, number> }}
   */
  function step({ now, dtMs, channels, fractions, urgent = false, calm = false, measured = {}, pumpFraction = 1 }) {
    const dtS = Math.max(0.1, Math.min(5, (dtMs || 1000) / 1000));
    const fans = channels.filter((c) => c.controllable);
    const duties = {};
    const fracs = {};
    for (const ch of fans) {
      // Not read yet: it follows the plan until its first reading says where it turns.
      if (!state.has(ch.id)) state.set(ch.id, { frac: ch.startFrac ?? fractions[ch.id] ?? 0.5, blind: ch.startFrac == null, riseAt: 0, zeroSince: 0, trim: 0, lastTarget: -1, kickFrom: 0, kickUntil: 0, falling: false });
      const s = state.get(ch.id);
      // Started before the fan's first reading: that reading is where it really turns.
      if (s.blind && Number.isFinite(ch.startFrac)) { s.frac = ch.startFrac; s.blind = false; }
      if (ch.kind === 'pump') {
        s.frac = Math.max(pumpFraction, (L.PUMP_FLOOR / 100));
        duties[ch.id] = Math.round(s.frac * 100);
        fracs[ch.id] = s.frac;
        continue;
      }
      let target = fractions[ch.id] ?? s.frac;
      // Stop only after STOP_AFTER_MS of not being needed; until then idle at the floor.
      // A fan already stopped (a card resting when Xenon takes it) stays stopped: the
      // wait is for one still turning, and starting it for a minute was heard for nothing.
      // On the way to a stop the fall to the floor is never left inside the band: a fan
      // a hair over it would never stop (seen in the simulator after a restart).
      if (target === 0) {
        if (!s.zeroSince) s.zeroSince = now;
        if (s.frac > 0 && (now - s.zeroSince < STOP_AFTER_MS || s.frac > (ch.minFrac ?? 0.2) + L.RATE.deadBand)) {
          target = ch.minFrac ?? 0.2;
          s.falling = true;
        }
      } else {
        s.zeroSince = 0;
        if (s.frac === 0) { s.frac = Math.max(target, ch.minFrac ?? 0.2); s.kickFrom = now; s.kickUntil = now + (ch.hasTach ? KICK_MS : KICK_BLIND_MS); }
      }
      if (target === 0) s.frac = 0;
      else moveToward(s, target, now, dtS, urgent, calm);
      fracs[ch.id] = s.frac;
    }
    // Beat groups: the group runs at its fastest member's speed, each fan trimmed. Only the
    // groups the planner priced as one: a case fan planned alone at 99 %, locked with three
    // radiator fans of its kind, dragged them from half to 91 % (23 Nov 2026).
    for (const g of groupsOf(fans.filter((c) => c.kind !== 'pump'))) {
      const shared = Math.max(...g.map((id) => fracs[id] ?? 0));
      for (const id of g) {
        const ch = fans.find((c) => c.id === id);
        const s = state.get(id);
        fracs[id] = shared;
        if (shared === 0) { duties[id] = 0; continue; }
        const raw = dutyFor(ch, shared);
        if (s.kickUntil > now && now - s.kickFrom >= KICK_MIN_MS && measured?.[id] > 0) s.kickUntil = 0;
        const kick = s.kickUntil > now && ch.startDuty != null ? ch.startDuty + KICK_EXTRA : 0;
        const floor = Math.max(ch.minDuty ?? 0, Math.min(100, kick));
        if (g.length > 1) trimFor(ch, s, shared, measured, dtS, raw, floor);
        duties[id] = Math.round(Math.max(floor, Math.min(100, raw + (g.length > 1 ? s.trim : 0))));
      }
    }
    return { duties, fractions: fracs };
  }

  return { step, reset: () => state.clear(), forget: (id) => state.delete(id) };
}

module.exports = { createSmoother, dutyFor, STOP_AFTER_MS };
