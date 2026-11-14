'use strict';
// The countdown before an automatic update: started, cancelled, ended with every condition
// checked again before the update is applied, and postponed by an hour.

const { normVer, decide } = require('./auto-update-decide.js');
const { TICK_MS, COUNTDOWN_MS, POSTPONE_MS } = require('./auto-update-limits.js');

function makeCountdown({
  d, now, setT, clearT, log, broadcast, su, auState, persist, schedule, buildState,
}) {
  function startCountdown(version) {
    const endsAt = now() + COUNTDOWN_MS;
    auState.countdown = { version, endsAt, timer: null };
    broadcast('update_auto', { phase: 'countdown', version, endsAt, seconds: Math.round(COUNTDOWN_MS / 1000) });
    log('auto-update: installing ' + version + ' in ' + Math.round(COUNTDOWN_MS / 1000) + 's unless postponed');
    auState.countdown.timer = setT(() => { finishCountdown(); }, COUNTDOWN_MS);
    if (auState.countdown.timer && typeof auState.countdown.timer.unref === 'function') auState.countdown.timer.unref();
  }

  function cancelCountdown(reason) {
    if (!auState.countdown) return;
    const version = auState.countdown.version;
    if (auState.countdown.timer) clearT(auState.countdown.timer);
    auState.countdown = null;
    broadcast('update_auto', { phase: 'cancelled', version, reason });
  }

  async function finishCountdown() {
    if (!auState.countdown || auState.stopped) return;
    const version = auState.countdown.version;
    auState.countdown.timer = null;
    try {
      // Everything again: the minute of countdown is exactly when someone may
      // have sat down, started a game or begun sending a file.
      const st = await buildState(true);
      const dec = decide(st, now());
      if (dec.action !== 'apply' || normVer(st.latest) !== normVer(version)) {
        auState.lastDecision = dec;
        auState.lastBlockers = dec.blockers || [];
        cancelCountdown(dec.reason);
        schedule(2 * 60 * 1000);
        return;
      }
      auState.countdown = null;
      auState.record = { ...auState.record, version: normVer(version), state: 'applying', reason: '', at: now() };
      await persist();
      broadcast('update_auto', { phase: 'applying', version });
      log('auto-update: installing ' + version);
      const r = su.apply({ quiet: true, hidden: true, port: d.port });
      if (!r || !r.ok) {
        const code = String((r && r.error) || 'apply_failed');
        if (code === 'apply_in_flight' || code === 'prepare_in_flight') {
          auState.record = { ...auState.record, state: 'ready', at: now() };
        } else {
          auState.record = { ...auState.record, state: 'failed', reason: code, failedVersion: normVer(version), at: now() };
          broadcast('update_auto', { phase: 'failed', version, reason: code });
        }
        await persist();
      }
      // On success the applier stops this process within seconds. If it does
      // not, the next tick's checkRunningApply() finds out why.
      schedule(60 * 1000);
    } catch (e) {
      auState.countdown = null;
      log('auto-update: install step failed: ' + (e && e.message));
      schedule(TICK_MS);
    }
  }

  // "Postpone by an hour" from any dashboard.
  function postpone() {
    auState.postponedUntil = now() + POSTPONE_MS;
    const had = !!auState.countdown;
    cancelCountdown('postponed');
    if (had || !auState.tickTimer) schedule(POSTPONE_MS);
    return { ok: true, postponedUntil: auState.postponedUntil };
  }

  return { startCountdown, cancelCountdown, postpone };
}

module.exports = { makeCountdown };
