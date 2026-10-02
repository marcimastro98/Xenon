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
//   - A 60-second countdown on every open dashboard first, with a button to
//     postpone by an hour, and every condition checked again when it ends.

const MIN_AGE_MS = 24 * 60 * 60 * 1000;
const IDLE_MIN_SEC = 10 * 60;
const NIGHT_START_HOUR = 3;
const NIGHT_END_HOUR = 5;
const FIRST_TICK_MS = 2 * 60 * 1000;
const TICK_MS = 10 * 60 * 1000;
const RECHECK_MS = 6 * 60 * 60 * 1000;
const COUNTDOWN_MS = 60 * 1000;
const POSTPONE_MS = 60 * 60 * 1000;
const PREPARE_RETRY_MS = 60 * 60 * 1000;
const PREPARE_MAX_TRIES = 5;
const APPLY_TIMEOUT_MS = 15 * 60 * 1000;
const NO_AUTO_MARKER = /<!--\s*xenon:no-auto\s*-->/i;

// A prepare failure that says the release itself is wrong. Retrying cannot fix
// it, so the version is treated like a failed install: manual only.
const PERMANENT_PREPARE_ERRORS = new Set([
  'signature_invalid', 'integrity_mismatch', 'version_mismatch', 'invalid_build', 'unexpected_archive',
]);

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
 *   minAgeMs, idleMinSec                           optional overrides
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

  let record = { version: '', state: 'idle', at: 0, reason: '', failedVersion: '' };
  let release = null;           // last successful checkRelease() answer
  let lastCheckAt = 0;
  let prepareTries = { version: '', count: 0, blockedUntil: 0 };
  let postponedUntil = 0;
  let countdown = null;         // { version, endsAt, timer }
  let tickTimer = null;
  let ticking = false;
  let stopped = false;
  let lastDecision = { action: 'wait', reason: 'starting' };
  let lastBlockers = [];
  let started = false;

  async function persist() {
    try { await d.store.write(record); } catch (e) { log('auto-update: could not save state: ' + (e && e.message)); }
  }

  function schedule(ms) {
    if (stopped) return;
    if (tickTimer) clearT(tickTimer);
    tickTimer = setT(() => { tickTimer = null; tick(); }, ms);
    if (tickTimer && typeof tickTimer.unref === 'function') tickTimer.unref();
  }

  // What happened to the attempt the PREVIOUS process started. The applier
  // replaces this process, so success is only visible from the new one.
  async function reconcile() {
    let saved = null;
    try { saved = await d.store.read(); } catch { saved = null; }
    if (saved && typeof saved === 'object') {
      record = {
        version: normVer(saved.version),
        state: String(saved.state || 'idle'),
        at: Number(saved.at) || 0,
        reason: String(saved.reason || ''),
        failedVersion: normVer(saved.failedVersion),
      };
    }
    if (record.state !== 'applying') return;
    if (normVer(d.currentVersion) === record.version) {
      record = { ...record, state: 'done', reason: '', at: now() };
      log('auto-update: now running ' + record.version);
    } else {
      let result = null;
      try { result = await d.readLastResult(); } catch { result = null; }
      const reason = (result && result.ok === false && result.reason) ? String(result.reason) : 'not_applied';
      record = { ...record, state: 'failed', reason, failedVersion: record.version, at: now() };
      log('auto-update: ' + record.version + ' did not install (' + reason + '); it will not be retried automatically');
    }
    await persist();
  }

  async function currentRelease() {
    const stale = !lastCheckAt || now() - lastCheckAt >= RECHECK_MS;
    try {
      const r = await d.checkRelease(stale);
      if (r && r.ok) { release = r; if (stale) lastCheckAt = now(); }
      else if (stale) lastCheckAt = now() - RECHECK_MS + PREPARE_RETRY_MS;   // offline: try again in an hour
    } catch { if (stale) lastCheckAt = now() - RECHECK_MS + PREPARE_RETRY_MS; }
    return release;
  }

  async function buildState(withSignals) {
    const rel = release || {};
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
      failedVersion: record.failedVersion,
      stagedVersion: staged && staged.version ? staged.version : '',
      prepareBlockedUntil: prepareTries.version === latest ? prepareTries.blockedUntil : 0,
      postponedUntil,
      blockers,
      idleSec,
      localHour: localHour(),
      minAgeMs: d.minAgeMs,
      idleMinSec: d.idleMinSec,
    };
  }

  // An apply this process started that never finished: the applier failed
  // before it stopped the server (update-result.json says so), or it vanished.
  async function checkRunningApply() {
    if (record.state !== 'applying') return false;
    let result = null;
    try { result = await d.readLastResult(); } catch { result = null; }
    const at = result && Date.parse(result.at || '');
    if (result && result.ok === false && Number.isFinite(at) && at >= record.at - 1000) {
      record = { ...record, state: 'failed', reason: String(result.reason || 'failed'), failedVersion: record.version, at: now() };
    } else if (su.lastSpawnError && su.lastSpawnError()) {
      record = { ...record, state: 'failed', reason: 'spawn_failed', failedVersion: record.version, at: now() };
    } else if (now() - record.at > APPLY_TIMEOUT_MS) {
      record = { ...record, state: 'failed', reason: 'apply_timeout', failedVersion: record.version, at: now() };
    } else {
      return true;   // still running: this process is about to be replaced
    }
    log('auto-update: ' + record.version + ' failed (' + record.reason + '); manual update only for this version');
    broadcast('update_auto', { phase: 'failed', version: record.version, reason: record.reason });
    await persist();
    return false;
  }

  async function tick() {
    if (stopped || ticking) return;
    ticking = true;
    let next = TICK_MS;
    try {
      if (countdown) return;   // the countdown owns the next step
      if (await checkRunningApply()) return;
      if (!d.isEnabled()) { lastDecision = { action: 'hold', reason: 'disabled' }; return; }
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
        startCountdown(st.latest);
      }
      lastDecision = dec;
      lastBlockers = dec.blockers || [];
    } catch (e) {
      log('auto-update: tick failed: ' + (e && e.message));
    } finally {
      ticking = false;
      if (!countdown) schedule(next);
    }
  }

  async function doPrepare(version) {
    const rel = release || {};
    if (prepareTries.version !== version) prepareTries = { version, count: 0, blockedUntil: 0 };
    prepareTries.count++;
    log('auto-update: downloading ' + version);
    try {
      await su.prepare({ tag: rel.tag || ('v' + version), version });
      prepareTries = { version, count: 0, blockedUntil: 0 };
      record = { ...record, version, state: 'ready', reason: '', at: now() };
      await persist();
      log('auto-update: ' + version + ' downloaded and verified');
    } catch (e) {
      const code = String((e && e.message) || e || 'prepare_failed');
      if (code === 'prepare_in_flight' || code === 'apply_in_flight') { prepareTries.count--; return; }
      if (PERMANENT_PREPARE_ERRORS.has(code) || prepareTries.count >= PREPARE_MAX_TRIES) {
        record = { ...record, version, state: 'failed', reason: code, failedVersion: version, at: now() };
        await persist();
        log('auto-update: ' + version + ' cannot be prepared (' + code + '); manual update only');
        return;
      }
      prepareTries.blockedUntil = now() + PREPARE_RETRY_MS;
      log('auto-update: download of ' + version + ' failed (' + code + '); retrying in an hour');
    }
  }

  function startCountdown(version) {
    const endsAt = now() + COUNTDOWN_MS;
    countdown = { version, endsAt, timer: null };
    broadcast('update_auto', { phase: 'countdown', version, endsAt, seconds: Math.round(COUNTDOWN_MS / 1000) });
    log('auto-update: installing ' + version + ' in ' + Math.round(COUNTDOWN_MS / 1000) + 's unless postponed');
    countdown.timer = setT(() => { finishCountdown(); }, COUNTDOWN_MS);
    if (countdown.timer && typeof countdown.timer.unref === 'function') countdown.timer.unref();
  }

  function cancelCountdown(reason) {
    if (!countdown) return;
    const version = countdown.version;
    if (countdown.timer) clearT(countdown.timer);
    countdown = null;
    broadcast('update_auto', { phase: 'cancelled', version, reason });
  }

  async function finishCountdown() {
    if (!countdown || stopped) return;
    const version = countdown.version;
    countdown.timer = null;
    try {
      // Everything again: the minute of countdown is exactly when someone may
      // have sat down, started a game or begun sending a file.
      const st = await buildState(true);
      const dec = decide(st, now());
      if (dec.action !== 'apply' || normVer(st.latest) !== normVer(version)) {
        lastDecision = dec;
        lastBlockers = dec.blockers || [];
        cancelCountdown(dec.reason);
        schedule(2 * 60 * 1000);
        return;
      }
      countdown = null;
      record = { ...record, version: normVer(version), state: 'applying', reason: '', at: now() };
      await persist();
      broadcast('update_auto', { phase: 'applying', version });
      log('auto-update: installing ' + version);
      const r = su.apply({ quiet: true, hidden: true, port: d.port });
      if (!r || !r.ok) {
        const code = String((r && r.error) || 'apply_failed');
        if (code === 'apply_in_flight' || code === 'prepare_in_flight') {
          record = { ...record, state: 'ready', at: now() };
        } else {
          record = { ...record, state: 'failed', reason: code, failedVersion: normVer(version), at: now() };
          broadcast('update_auto', { phase: 'failed', version, reason: code });
        }
        await persist();
      }
      // On success the applier stops this process within seconds. If it does
      // not, the next tick's checkRunningApply() finds out why.
      schedule(60 * 1000);
    } catch (e) {
      countdown = null;
      log('auto-update: install step failed: ' + (e && e.message));
      schedule(TICK_MS);
    }
  }

  // "Postpone by an hour" from any dashboard.
  function postpone() {
    postponedUntil = now() + POSTPONE_MS;
    const had = !!countdown;
    cancelCountdown('postponed');
    if (had || !tickTimer) schedule(POSTPONE_MS);
    return { ok: true, postponedUntil };
  }

  // The toggle moved. Off cancels a countdown at once; on looks again soon.
  function settingsChanged() {
    if (!started || stopped) return;
    if (!d.isEnabled()) { cancelCountdown('disabled'); lastDecision = { action: 'hold', reason: 'disabled' }; return; }
    if (!countdown && !ticking) schedule(5 * 1000);
  }

  function status() {
    const rel = release || {};
    let staged = null;
    try { staged = su.staged(); } catch { staged = null; }
    const published = Date.parse(rel.publishedAt || '');
    const minAge = Number.isFinite(d.minAgeMs) ? d.minAgeMs : MIN_AGE_MS;
    return {
      enabled: !!d.isEnabled(),
      current: normVer(d.currentVersion),
      latest: normVer(rel.latest),
      staged: staged && staged.version ? normVer(staged.version) : '',
      action: lastDecision.action,
      reason: lastDecision.reason,
      blockers: lastBlockers.slice(),
      eligibleAt: Number.isFinite(published) ? published + minAge : 0,
      countdownEndsAt: countdown ? countdown.endsAt : 0,
      postponedUntil: postponedUntil > now() ? postponedUntil : 0,
      last: { version: record.version, state: record.state, reason: record.reason, at: record.at },
    };
  }

  // Is this a moment the app itself could restart (the native shell update)?
  // Same conditions as the backend, minus everything about releases.
  async function safeNow() {
    let sig = null;
    try { sig = await d.signals(); } catch { return false; }
    const blockers = Array.isArray(sig && sig.blockers) ? sig.blockers : [];
    if (blockers.length) return false;
    const idleMin = Number.isFinite(d.idleMinSec) ? d.idleMinSec : IDLE_MIN_SEC;
    if (sig && typeof sig.idleSec === 'number') return sig.idleSec >= idleMin;
    return inNightWindow(localHour());
  }

  async function start() {
    if (started) return;
    started = true;
    await reconcile();
    if (record.state === 'done' || record.state === 'failed') {
      broadcast('update_auto', { phase: record.state, version: record.version, reason: record.reason });
    }
    schedule(FIRST_TICK_MS);
  }

  function stop() {
    stopped = true;
    if (tickTimer) { clearT(tickTimer); tickTimer = null; }
    if (countdown && countdown.timer) clearT(countdown.timer);
    countdown = null;
  }

  return { start, stop, tick, postpone, settingsChanged, status, safeNow, _record: () => ({ ...record }) };
}

module.exports = {
  decide, createAutoUpdater, hasNoAutoMarker, inNightWindow,
  MIN_AGE_MS, IDLE_MIN_SEC, COUNTDOWN_MS, POSTPONE_MS, TICK_MS, FIRST_TICK_MS, RECHECK_MS,
  PREPARE_RETRY_MS, PREPARE_MAX_TRIES, APPLY_TIMEOUT_MS,
};
