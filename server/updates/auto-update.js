'use strict';

// ── Automatic updates ────────────────────────────────────────────────────────
// Installs a new release by itself, at a moment nobody is using the PC, through
// the SAME verified path the "Update now" button uses (self-update.js prepare →
// apply, the external applier with its backup and rollback). Nothing here
// downloads, verifies or copies anything on its own; it only decides WHEN.
//
// Two halves, so the part that decides can be tested exhaustively:
//   decide(state, now)      pure: what to do next, and why not yet
//   createAutoUpdater(deps) the timer loop around it, every effect injected
//
// The rules, and why each exists:
//   - Off when the user switched it off, and on any install that cannot
//     update itself (git checkout, applier missing).
//   - Never when applying would need a UAC prompt: nobody is there to answer
//     it, and an unanswered prompt leaves the server stopped.
//   - A release is only taken 24 hours after it was published. A broken
//     release reaches the people who pressed "Update now" first, and the
//     maintainer has a day to pull it before it reaches everyone by itself.
//   - A release whose notes carry <!-- xenon:no-auto --> is never automatic:
//     the maintainer's brake for a release that must be installed by hand.
//   - A version that failed once automatically is never retried automatically.
//     The applier rolls back and keeps its staging, so a retry loop would
//     restart the server over and over; the manual button stays available.
//   - Only when nothing is going on: no game, Performance Mode off, no file
//     transfer, no disk cleanup, no Claude request waiting for an answer, no
//     live voice session, no call ringing, and the PC idle for 10 minutes.
//     Where idle time cannot be read, only between 03:00 and 05:00.
//   - Or in the first 10 minutes after Xenon starts, with nothing going on
//     either: someone who switches the PC on, plays and switches it off is
//     never idle for 10 minutes, so the idle rule alone never reached them.
//     The release is downloaded in one session and installed at the next start.
//   - A 60-second countdown on every open dashboard first, with a button to
//     postpone by an hour, and every condition checked again when it ends.

const {
  MIN_AGE_MS, IDLE_MIN_SEC, normVer, hasNoAutoMarker, inNightWindow, decide,
} = require('./auto-update-decide.js');
const {
  STARTUP_WINDOW_MS, FIRST_TICK_MS, TICK_MS, RECHECK_MS, COUNTDOWN_MS, POSTPONE_MS, PREPARE_RETRY_MS,
  PREPARE_MAX_TRIES, APPLY_TIMEOUT_MS,
} = require('./auto-update-limits.js');

const { makeCountdown } = require('./auto-update-countdown.js');

const { makeState } = require('./auto-update-state.js');

const { makeSteps } = require('./auto-update-steps.js');

/**
 * The loop. Every effect is a dependency, so the tests drive it with a fake
 * clock and fake modules.
 *
 * deps:
 *   currentVersion        string (APP_VERSION)
 *   selfUpdate            the createSelfUpdate() instance
 *   checkRelease(force)   → Promise<{ok, latest, tag, publishedAt, noAuto}>
 *   isEnabled()           → boolean (the autoUpdate setting)
 *   signals()             → Promise<{blockers:string[], idleSec:number|null}>
 *   readLastResult()      → Promise<object|null> (update-result.json)
 *   store                 { read() → Promise<object|null>, write(obj) → Promise }
 *   broadcast(event, data)
 *   log(msg)
 *   port                  number, handed to the applier
 *   now(), localHour(), setTimeout, clearTimeout   (default: the real ones)
 *   minAgeMs, idleMinSec, startupWindowMs          optional overrides
 */
function createAutoUpdater(deps) {
  const d = deps || {};
  const now = d.now || (() => Date.now());
  const localHour = d.localHour || (() => new Date(now()).getHours());
  const setT = d.setTimeout || setTimeout;
  const clearT = d.clearTimeout || clearTimeout;
  const log = d.log || (() => {});
  const broadcast = d.broadcast || (() => {});
  const su = d.selfUpdate;

  const auState = {
    record: { version: '', state: 'idle', at: 0, reason: '', failedVersion: '' },
    release: null,           // last successful checkRelease() answer
    lastCheckAt: 0,
    prepareTries: { version: '', count: 0, blockedUntil: 0 },
    postponedUntil: 0,
    countdown: null,         // { version, endsAt, timer }
    tickTimer: null,
    ticking: false,
    stopped: false,
    lastDecision: { action: 'wait', reason: 'starting' },
    lastBlockers: [],
    started: false,
    startedAt: 0,
  };

  async function persist() {
    try { await d.store.write(auState.record); } catch (e) { log('auto-update: could not save state: ' + (e && e.message)); }
  }

  function schedule(ms) {
    if (auState.stopped) return;
    if (auState.tickTimer) clearT(auState.tickTimer);
    auState.tickTimer = setT(() => { auState.tickTimer = null; tick(); }, ms);
    if (auState.tickTimer && typeof auState.tickTimer.unref === 'function') auState.tickTimer.unref();
  }

  const {
    reconcile, currentRelease, checkRunningApply, doPrepare,
  } = makeSteps({ d, now, log, broadcast, su, auState, persist });

  const { buildState, status, safeNow } = makeState({ d, now, localHour, su, auState });

  async function tick() {
    if (auState.stopped || auState.ticking) return;
    auState.ticking = true;
    let next = TICK_MS;
    try {
      if (auState.countdown) return;   // the countdown owns the next step
      if (await checkRunningApply()) return;
      if (!d.isEnabled()) { auState.lastDecision = { action: 'hold', reason: 'disabled' }; return; }
      if (su.isPreparing && su.isPreparing()) return;                 // a manual prepare is running
      if (su.applyInFlight && su.applyInFlight()) return;             // a manual apply is running
      await currentRelease();
      // Signals are only read once there is something to install: on most
      // ticks there is not, and reading idle time on Windows costs a spawn.
      // Without signals the decision can only stop at "waiting for the night"
      // (idle unknown) or reach "apply"; either way the real signals decide.
      let st = await buildState(false);
      let dec = decide(st, now());
      if (dec.action === 'apply' || dec.reason === 'waiting_night') {
        st = await buildState(true);
        dec = decide(st, now());
      }
      if (st.stagedVersion && normVer(st.stagedVersion) === normVer(st.latest) && dec.action === 'wait') {
        // Ready and waiting for a quiet moment: look again sooner than usual.
        next = 2 * 60 * 1000;
      }
      if (dec.action === 'prepare') {
        await doPrepare(st.latest);
        next = 60 * 1000;   // prepared: re-decide soon
      } else if (dec.action === 'apply') {
        startCountdown(st.latest, dec.reason === 'ready_startup');
      }
      auState.lastDecision = dec;
      auState.lastBlockers = dec.blockers || [];
    } catch (e) {
      log('auto-update: tick failed: ' + (e && e.message));
    } finally {
      auState.ticking = false;
      if (!auState.countdown) schedule(next);
    }
  }

  const {
    startCountdown, cancelCountdown, postpone,
  } = makeCountdown({ d, now, setT, clearT, log, broadcast, su, auState, persist, schedule, buildState });

  // The toggle moved. Off cancels a countdown at once; on looks again soon.
  function settingsChanged() {
    if (!auState.started || auState.stopped) return;
    if (!d.isEnabled()) { cancelCountdown('disabled'); auState.lastDecision = { action: 'hold', reason: 'disabled' }; return; }
    if (!auState.countdown && !auState.ticking) schedule(5 * 1000);
  }

  async function start() {
    if (auState.started) return;
    auState.started = true;
    auState.startedAt = now();
    await reconcile();
    if (auState.record.state === 'done' || auState.record.state === 'failed') {
      broadcast('update_auto', { phase: auState.record.state, version: auState.record.version, reason: auState.record.reason });
    }
    schedule(FIRST_TICK_MS);
  }

  function stop() {
    auState.stopped = true;
    if (auState.tickTimer) { clearT(auState.tickTimer); auState.tickTimer = null; }
    if (auState.countdown && auState.countdown.timer) clearT(auState.countdown.timer);
    auState.countdown = null;
  }

  return { start, stop, tick, postpone, settingsChanged, status, safeNow, _record: () => ({ ...auState.record }) };
}

module.exports = {
  decide, createAutoUpdater, hasNoAutoMarker, inNightWindow,
  MIN_AGE_MS, IDLE_MIN_SEC, STARTUP_WINDOW_MS, COUNTDOWN_MS, POSTPONE_MS, TICK_MS, FIRST_TICK_MS, RECHECK_MS,
  PREPARE_RETRY_MS, PREPARE_MAX_TRIES, APPLY_TIMEOUT_MS,
};
