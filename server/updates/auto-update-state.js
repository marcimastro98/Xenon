'use strict';
// What the automatic updater knows at a moment: the state the decision is taken from, the
// status the dashboard shows, and whether this moment is a safe one.

const { MIN_AGE_MS, IDLE_MIN_SEC, normVer, inNightWindow } = require('./auto-update-decide.js');
const { STARTUP_WINDOW_MS } = require('./auto-update-limits.js');

function makeState({ d, now, localHour, su, auState }) {
  const startupWindowMs = Number.isFinite(d.startupWindowMs) ? d.startupWindowMs : STARTUP_WINDOW_MS;

  function inStartupWindow() {
    return auState.startedAt > 0 && now() - auState.startedAt < startupWindowMs;
  }

  async function buildState(withSignals) {
    const rel = auState.release || {};
    const latest = normVer(rel.latest);
    let blockers = [];
    let idleSec = null;
    if (withSignals) {
      try {
        const sig = await d.signals();
        blockers = Array.isArray(sig && sig.blockers) ? sig.blockers : [];
        idleSec = sig && typeof sig.idleSec === 'number' ? sig.idleSec : null;
      } catch { blockers = ['signals_unavailable']; }
    }
    let staged = null;
    try { staged = su.staged(); } catch { staged = null; }
    return {
      enabled: !!d.isEnabled(),
      supported: !!su.supported(),
      needsElevation: typeof su.needsElevation === 'function' ? !!su.needsElevation() : false,
      current: d.currentVersion,
      latest,
      publishedAt: rel.publishedAt || '',
      noAuto: !!rel.noAuto,
      failedVersion: auState.record.failedVersion,
      stagedVersion: staged && staged.version ? staged.version : '',
      prepareBlockedUntil: auState.prepareTries.version === latest ? auState.prepareTries.blockedUntil : 0,
      postponedUntil: auState.postponedUntil,
      blockers,
      idleSec,
      localHour: localHour(),
      startup: inStartupWindow(),
      minAgeMs: d.minAgeMs,
      idleMinSec: d.idleMinSec,
    };
  }

  function status() {
    const rel = auState.release || {};
    let staged = null;
    try { staged = su.staged(); } catch { staged = null; }
    const published = Date.parse(rel.publishedAt || '');
    const minAge = Number.isFinite(d.minAgeMs) ? d.minAgeMs : MIN_AGE_MS;
    return {
      enabled: !!d.isEnabled(),
      current: normVer(d.currentVersion),
      latest: normVer(rel.latest),
      staged: staged && staged.version ? normVer(staged.version) : '',
      action: auState.lastDecision.action,
      reason: auState.lastDecision.reason,
      blockers: auState.lastBlockers.slice(),
      eligibleAt: Number.isFinite(published) ? published + minAge : 0,
      startupUntil: inStartupWindow() ? auState.startedAt + startupWindowMs : 0,
      countdownEndsAt: auState.countdown ? auState.countdown.endsAt : 0,
      postponedUntil: auState.postponedUntil > now() ? auState.postponedUntil : 0,
      last: { version: auState.record.version, state: auState.record.state, reason: auState.record.reason, at: auState.record.at },
    };
  }

  // Is this a moment the app itself could restart (the native shell update)?
  // Same conditions as the backend, minus everything about releases.
  async function safeNow() {
    let sig = null;
    try { sig = await d.signals(); } catch { return false; }
    const blockers = Array.isArray(sig && sig.blockers) ? sig.blockers : [];
    if (blockers.length) return false;
    if (inStartupWindow()) return true;
    const idleMin = Number.isFinite(d.idleMinSec) ? d.idleMinSec : IDLE_MIN_SEC;
    if (sig && typeof sig.idleSec === 'number') return sig.idleSec >= idleMin;
    return inNightWindow(localHour());
  }

  return { buildState, status, safeNow };
}

module.exports = { makeState };
