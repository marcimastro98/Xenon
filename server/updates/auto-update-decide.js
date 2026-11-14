'use strict';
// Decides whether an update may install itself now: a newer version, old enough, the PC idle,
// at night, and not marked as one to ask about.

const MIN_AGE_MS = 24 * 60 * 60 * 1000;
const IDLE_MIN_SEC = 10 * 60;
const NIGHT_START_HOUR = 3;
const NIGHT_END_HOUR = 5;

const NO_AUTO_MARKER = /<!--\s*xenon:no-auto\s*-->/i;

function parseVer(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function newer(a, b) {
  const x = parseVer(a);
  const y = parseVer(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
const normVer = (v) => String(v || '').trim().replace(/^v/i, '');

function hasNoAutoMarker(notes) {
  return NO_AUTO_MARKER.test(String(notes || ''));
}

function inNightWindow(hour) {
  return Number.isInteger(hour) && hour >= NIGHT_START_HOUR && hour < NIGHT_END_HOUR;
}

/**
 * What to do next. Pure: everything it needs is in `s`.
 * @param {object} s
 *   enabled, supported, needsElevation      booleans
 *   current, latest                          version strings
 *   publishedAt                              ms epoch or ISO string ('' = unknown)
 *   noAuto                                   the release carries the no-auto marker
 *   failedVersion                            last version that failed automatically
 *   stagedVersion                            version prepared and verified on disk
 *   prepareBlockedUntil                      ms epoch: prepare backoff after a failure
 *   postponedUntil                           ms epoch
 *   blockers                                 string[] of things in progress
 *   idleSec                                  number, or null when unknown here
 *   localHour                                0..23
 *   minAgeMs, idleMinSec                     optional overrides (tests, E2E)
 * @param {number} now ms epoch
 * @returns {{action:'hold'|'wait'|'prepare'|'apply', reason:string, blockers?:string[], eligibleAt?:number}}
 */
function decide(s, now) {
  const st = s || {};
  if (!st.enabled) return { action: 'hold', reason: 'disabled' };
  if (!st.supported) return { action: 'hold', reason: 'unsupported' };
  if (!st.latest || !newer(st.latest, st.current)) return { action: 'wait', reason: 'up_to_date' };
  if (st.noAuto) return { action: 'hold', reason: 'no_auto_release' };
  if (st.failedVersion && normVer(st.failedVersion) === normVer(st.latest)) return { action: 'hold', reason: 'failed_before' };
  if (st.needsElevation) return { action: 'hold', reason: 'needs_elevation' };

  const minAge = Number.isFinite(st.minAgeMs) ? st.minAgeMs : MIN_AGE_MS;
  const published = typeof st.publishedAt === 'number' ? st.publishedAt : Date.parse(st.publishedAt || '');
  // No publish date means the rule cannot be checked, and an unchecked rule is
  // a closed one: the release stays manual.
  if (!Number.isFinite(published)) return { action: 'wait', reason: 'too_new' };
  const eligibleAt = published + minAge;
  if (now < eligibleAt) return { action: 'wait', reason: 'too_new', eligibleAt };

  if (normVer(st.stagedVersion) !== normVer(st.latest)) {
    if (st.prepareBlockedUntil && now < st.prepareBlockedUntil) return { action: 'wait', reason: 'prepare_retry' };
    return { action: 'prepare', reason: 'download' };
  }
  if (st.postponedUntil && now < st.postponedUntil) return { action: 'wait', reason: 'postponed' };
  const blockers = Array.isArray(st.blockers) ? st.blockers.filter(Boolean) : [];
  if (blockers.length) return { action: 'wait', reason: 'busy', blockers };

  const idleMin = Number.isFinite(st.idleMinSec) ? st.idleMinSec : IDLE_MIN_SEC;
  if (typeof st.idleSec === 'number' && Number.isFinite(st.idleSec)) {
    if (st.idleSec < idleMin) return { action: 'wait', reason: 'user_active' };
  } else if (!inNightWindow(st.localHour)) {
    return { action: 'wait', reason: 'waiting_night' };
  }
  return { action: 'apply', reason: 'ready' };
}

module.exports = {
  MIN_AGE_MS, IDLE_MIN_SEC, NIGHT_START_HOUR, NIGHT_END_HOUR, NO_AUTO_MARKER, parseVer, newer,
  normVer, hasNoAutoMarker, inNightWindow, decide,
};
