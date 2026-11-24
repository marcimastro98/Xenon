'use strict';
// A restart of seconds (an update, a crash and its relaunch) is not a new takeover. While
// the engine is down the board takes its headers back and its curve runs them fast: a case
// fan went from 38 % to 81 % in ten seconds, and a brain that started from that speed fell
// from it at 1 %/s for 80 s after every restart (23 Nov 2026). A brain started within
// RESUME_MS of the last one's last tick starts each fan at what that one asked, never above
// what the fan turns at now: a fan the board slowed starts where it turns, as on any
// takeover. Only a brain that was driving is resumed: watching, its speeds were never the fans'.
// They are written every few seconds on their own (loop-save.js): an update ends the engine
// by force, with no save on the way out.
const RESUME_MS = 120000;

/** @param {any} o @param {Set<string>} ids @returns {Record<string, number>} */
function fractionsOf(o, ids) {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  for (const [id, f] of Object.entries(o)) if (ids.has(id) && Number.isFinite(f) && f >= 0 && f <= 1) out[id] = f;
  return out;
}

/**
 * What a brain leaves for the next one: its last speeds and takeover speeds, while driving.
 * @param {{ at: number, out: any, tookAt: any, driving: boolean }} st
 */
function lastOf({ at, out, tookAt, driving }) {
  return driving && out && at ? { at, out: { ...out }, tookAt: { ...tookAt } } : null;
}

/**
 * The last brain's speeds, if it stopped less than RESUME_MS before `now`; null otherwise.
 * @param {any} saved what last() answered, as saved @param {number} now @param {Set<string>} ids
 * @returns {{ out: Record<string, number>, tookAt: Record<string, number> }|null}
 */
function resumeOf(saved, now, ids) {
  if (!saved || typeof saved !== 'object' || !Number.isFinite(saved.at)) return null;
  const gap = now - saved.at;
  if (!(gap >= 0 && gap <= RESUME_MS)) return null;
  return { out: fractionsOf(saved.out, ids), tookAt: fractionsOf(saved.tookAt, ids) };
}

module.exports = { lastOf, resumeOf, RESUME_MS };
