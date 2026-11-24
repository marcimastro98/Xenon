'use strict';
// Airflow's safety layer: the last word on every value written to a fan, and
// deliberately simpler than the brain it checks. It knows nothing about noise or
// comfort; it only decides, every tick, whether each channel takes the brain's
// value, goes to 100 %, or goes back to the firmware (BIOS curve, GPU auto, hub
// default). The hardware-owning process repeats the overheat, lease and clamp
// rules on its own side (server/fan-hands.ps1), so a dead engine is
// covered too. The rules, in order:
//   1. Overheat: any trusted component at its `full` temperature -> every channel
//      100 %, until all are RESUME_BELOW cooler for RESUME_AFTER_MS.
//   2. Brain silent for LEASE_MS -> every channel to the firmware.
//   3. A sensor a channel depends on is missing, stale, absurd or frozen -> that
//      channel to the firmware. One only late (older than STALE_MS, not LATE_OK_MS)
//      that the hands guard themselves keeps the channel at its last speed instead:
//      nothing new is decided on it, and it may start full, never end it.
//   4. A fan reading 0 RPM for STALL_MS while asked to turn (any duty above 0)
//      -> that channel to the firmware, with an alert, until cleared.
//   5. Every value clamped: never below the channel's minimum (pumps never below
//      PUMP_FLOOR), 0 only where the fan stops safely and either the user allowed
//      it or the device stops that fan by itself (a graphics card's zero-RPM mode),
//      never above 100, at most one write per channel per WRITE_EVERY_MS.
const L = require('./limits.js');

// A die reading that has not moved by a single step for FROZEN_MS while its
// component's power swung this far is a frozen sensor, not a steady one: a die
// follows its power within a second. The GPU swing is larger because cards report
// whole degrees and a big cooler moves little per watt.
const FROZEN_MS = 30000;
const FROZEN_POWER_SWING_W = Object.freeze({ cpu: 30, gpu: 80 });

/**
 * @typedef {{ value: number|null, at: number, guarded?: boolean }} Reading
 * @typedef {{ id: string, kind?: 'fan'|'pump', rpm?: number|null, hasTach?: boolean,
 *   minDuty?: number, zeroOk?: boolean, zeroByDefault?: boolean, deps?: string[] }} Channel
 * @typedef {{ at: number, targets: Record<string, number>, allowZero?: boolean }} Plan
 * @typedef {{ action: 'set', duty: number, write: boolean } | { action: 'firmware', why: string }} Verdict
 */

function createSafety({ cpuName = '', clock = Date.now } = {}) {
  let full = false;
  let coolSince = 0;
  /** @type {Map<string, number>} */
  const zeroSince = new Map();
  /** @type {Set<string>} */
  const stalled = new Set();
  /** @type {Map<string, { duty: number, at: number }>} */
  const written = new Map();
  /** @type {Map<string, { value: number, since: number, pMin: number, pMax: number }>} */
  const still = new Map();
  // Every component ever read: one that vanishes from the readings is untrusted,
  // not forgotten (a driver that drops a key must not silence its channels).
  /** @type {Set<string>} */
  const known = new Set();

  // Frozen: the same value for FROZEN_MS while the component's power swung.
  function frozen(name, r, power, now) {
    const s = still.get(name);
    if (!s || s.value !== r.value) {
      still.set(name, { value: r.value, since: now, pMin: power ?? Infinity, pMax: power ?? -Infinity });
      return false;
    }
    if (Number.isFinite(power)) { s.pMin = Math.min(s.pMin, power); s.pMax = Math.max(s.pMax, power); }
    const swing = FROZEN_POWER_SWING_W[name];
    return swing != null && now - s.since >= FROZEN_MS && s.pMax - s.pMin >= swing;
  }

  /** @returns {{ bad: Set<string>, late: Set<string> }} the readings that can't be trusted, and those only late */
  function untrusted(temps, power, now) {
    const bad = new Set();
    const late = new Set();
    for (const name of known) if (!temps || !(name in temps)) bad.add(name);
    for (const [name, r] of Object.entries(temps || {})) {
      known.add(name);
      if (!r || !L.saneTemp(r.value) || !Number.isFinite(r.at)) bad.add(name);
      else if (now - r.at > L.STALE_MS) (r.guarded === true && now - r.at <= L.LATE_OK_MS ? late : bad).add(name);
      else if (frozen(name, r, power?.[name], now)) bad.add(name);
    }
    return { bad, late };
  }

  function overheated(temps, bad, late, now) {
    let hot = false;
    let allCool = true;
    for (const [name, r] of Object.entries(temps || {})) {
      const limit = L.fullAt(name, cpuName);
      if (limit == null || bad.has(name)) continue;
      if (r.value >= limit) hot = true;
      if (late.has(name)) allCool = false;
      else if (r.value > limit - L.RESUME_BELOW) allCool = false;
    }
    if (hot) { full = true; coolSince = 0; return true; }
    if (!full) return false;
    if (!allCool) { coolSince = 0; return true; }
    if (!coolSince) coolSince = now;
    if (now - coolSince >= L.RESUME_AFTER_MS) { full = false; coolSince = 0; return false; }
    return true;
  }

  /** @param {Channel} ch @param {number} duty @param {boolean} allowZero */
  function clampDuty(ch, duty, allowZero) {
    const want = Math.min(100, Math.max(0, Number.isFinite(duty) ? duty : 100));
    if (ch.kind === 'pump') return Math.max(want, L.PUMP_FLOOR, ch.minDuty || 0);
    if (want === 0 && ch.zeroOk && (allowZero || ch.zeroByDefault)) return 0;
    return Math.max(want, ch.minDuty || 0, 1);
  }

  function stallCheck(ch, duty, now) {
    if (!ch.hasTach) return false;
    const asked = duty > 0;
    if (!asked || ch.rpm == null || ch.rpm > 0) { zeroSince.delete(ch.id); return false; }
    if (!zeroSince.has(ch.id)) zeroSince.set(ch.id, now);
    if (now - zeroSince.get(ch.id) >= L.STALL_MS) { stalled.add(ch.id); return true; }
    return false;
  }

  /** @returns {Verdict} */
  function writeVerdict(ch, duty, now) {
    const last = written.get(ch.id);
    const write = !last || (last.duty !== duty && now - last.at >= L.WRITE_EVERY_MS);
    if (write) written.set(ch.id, { duty, at: now });
    return { action: 'set', duty: write || !last ? duty : last.duty, write };
  }

  /**
   * @param {{ temps: Record<string, Reading>, power?: Record<string, number>,
   *   channels: Channel[], plan: Plan|null }} input
   */
  function check({ temps, power, channels, plan }) {
    const now = clock();
    const { bad, late } = untrusted(temps, power, now);
    const hot = overheated(temps, bad, late, now);
    const silent = !plan || !Number.isFinite(plan.at) || now - plan.at > L.LEASE_MS;
    const seen = [...known];
    /** @type {Record<string, Verdict>} */
    const out = {};
    const alerts = [];
    for (const ch of channels || []) {
      const firmware = (why) => { out[ch.id] = { action: 'firmware', why }; written.delete(ch.id); };
      if (hot) { out[ch.id] = writeVerdict(ch, 100, now); continue; }
      if (silent) { firmware('brain'); continue; }
      const deps = (ch.deps?.length ? ch.deps : seen).filter((d) => seen.includes(d));
      if (!deps.length && seen.length) { firmware('sensor'); continue; }
      if (deps.some((d) => bad.has(d))) { firmware('sensor'); continue; }
      if (deps.some((d) => late.has(d))) {
        const last = written.get(ch.id);
        if (last) out[ch.id] = { action: 'set', duty: last.duty, write: false };
        else firmware('sensor');
        continue;
      }
      const duty = clampDuty(ch, plan.targets?.[ch.id], plan.allowZero === true);
      if (stalled.has(ch.id) || stallCheck(ch, duty, now)) {
        firmware('stall');
        alerts.push({ code: 'stall', id: ch.id });
        continue;
      }
      out[ch.id] = writeVerdict(ch, duty, now);
    }
    const mode = hot ? 'full' : silent ? 'firmware' : 'brain';
    return { mode, why: hot ? 'hot' : silent ? 'brain' : null, channels: out, alerts, untrusted: [...bad, ...late] };
  }

  return {
    check,
    /** Lets a stalled channel be driven again (after the user checked the fan). */
    clear: (id) => { stalled.delete(id); zeroSince.delete(id); },
    stalled: () => [...stalled],
    reset() { full = false; coolSince = 0; zeroSince.clear(); stalled.clear(); written.clear(); still.clear(); known.clear(); },
  };
}

module.exports = { createSafety, FROZEN_MS, FROZEN_POWER_SWING_W };
