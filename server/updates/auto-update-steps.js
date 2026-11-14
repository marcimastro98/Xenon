'use strict';
// The steps of an automatic update besides the countdown: what the last run left behind put in
// order at start, the release looked up, an update under way watched until it ends or times
// out, and the download prepared.

const { normVer } = require('./auto-update-decide.js');
const {
  RECHECK_MS, PREPARE_RETRY_MS, PREPARE_MAX_TRIES, APPLY_TIMEOUT_MS, PERMANENT_PREPARE_ERRORS,
} = require('./auto-update-limits.js');

function makeSteps({ d, now, log, broadcast, su, auState, persist }) {
  // What happened to the attempt the PREVIOUS process started. The applier
  // replaces this process, so success is only visible from the new one.
  async function reconcile() {
    let saved = null;
    try { saved = await d.store.read(); } catch { saved = null; }
    if (saved && typeof saved === 'object') {
      auState.record = {
        version: normVer(saved.version),
        state: String(saved.state || 'idle'),
        at: Number(saved.at) || 0,
        reason: String(saved.reason || ''),
        failedVersion: normVer(saved.failedVersion),
      };
    }
    if (auState.record.state !== 'applying') return;
    if (normVer(d.currentVersion) === auState.record.version) {
      auState.record = { ...auState.record, state: 'done', reason: '', at: now() };
      log('auto-update: now running ' + auState.record.version);
    } else {
      let result = null;
      try { result = await d.readLastResult(); } catch { result = null; }
      const reason = (result && result.ok === false && result.reason) ? String(result.reason) : 'not_applied';
      auState.record = { ...auState.record, state: 'failed', reason, failedVersion: auState.record.version, at: now() };
      log('auto-update: ' + auState.record.version + ' did not install (' + reason + '); it will not be retried automatically');
    }
    await persist();
  }

  async function currentRelease() {
    const stale = !auState.lastCheckAt || now() - auState.lastCheckAt >= RECHECK_MS;
    try {
      const r = await d.checkRelease(stale);
      if (r && r.ok) { auState.release = r; if (stale) auState.lastCheckAt = now(); }
      else if (stale) auState.lastCheckAt = now() - RECHECK_MS + PREPARE_RETRY_MS;   // offline: try again in an hour
    } catch { if (stale) auState.lastCheckAt = now() - RECHECK_MS + PREPARE_RETRY_MS; }
    return auState.release;
  }

  // An apply this process started that never finished: the applier failed
  // before it stopped the server (update-result.json says so), or it vanished.
  async function checkRunningApply() {
    if (auState.record.state !== 'applying') return false;
    let result = null;
    try { result = await d.readLastResult(); } catch { result = null; }
    const at = result && Date.parse(result.at || '');
    if (result && result.ok === false && Number.isFinite(at) && at >= auState.record.at - 1000) {
      auState.record = { ...auState.record, state: 'failed', reason: String(result.reason || 'failed'), failedVersion: auState.record.version, at: now() };
    } else if (su.lastSpawnError && su.lastSpawnError()) {
      auState.record = { ...auState.record, state: 'failed', reason: 'spawn_failed', failedVersion: auState.record.version, at: now() };
    } else if (now() - auState.record.at > APPLY_TIMEOUT_MS) {
      auState.record = { ...auState.record, state: 'failed', reason: 'apply_timeout', failedVersion: auState.record.version, at: now() };
    } else {
      return true;   // still running: this process is about to be replaced
    }
    log('auto-update: ' + auState.record.version + ' failed (' + auState.record.reason + '); manual update only for this version');
    broadcast('update_auto', { phase: 'failed', version: auState.record.version, reason: auState.record.reason });
    await persist();
    return false;
  }

  async function doPrepare(version) {
    const rel = auState.release || {};
    if (auState.prepareTries.version !== version) auState.prepareTries = { version, count: 0, blockedUntil: 0 };
    auState.prepareTries.count++;
    log('auto-update: downloading ' + version);
    try {
      await su.prepare({ tag: rel.tag || ('v' + version), version });
      auState.prepareTries = { version, count: 0, blockedUntil: 0 };
      auState.record = { ...auState.record, version, state: 'ready', reason: '', at: now() };
      await persist();
      log('auto-update: ' + version + ' downloaded and verified');
    } catch (e) {
      const code = String((e && e.message) || e || 'prepare_failed');
      if (code === 'prepare_in_flight' || code === 'apply_in_flight') { auState.prepareTries.count--; return; }
      if (PERMANENT_PREPARE_ERRORS.has(code) || auState.prepareTries.count >= PREPARE_MAX_TRIES) {
        auState.record = { ...auState.record, version, state: 'failed', reason: code, failedVersion: version, at: now() };
        await persist();
        log('auto-update: ' + version + ' cannot be prepared (' + code + '); manual update only');
        return;
      }
      auState.prepareTries.blockedUntil = now() + PREPARE_RETRY_MS;
      log('auto-update: download of ' + version + ' failed (' + code + '); retrying in an hour');
    }
  }

  return { reconcile, currentRelease, checkRunningApply, doPrepare };
}

module.exports = { makeSteps };
