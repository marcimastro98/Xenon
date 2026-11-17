// What a running session shows on the page and every way it ends: the restore, the auto-restore
// after its activity, the end when its app is gone and the end after idle.
'use strict';

(() => {
  const {
    state, nobodyLooking, _procKey, _cancelAutoRestore, _idleEligible, _busyNow,
  } = window.PerformanceSessionState;
  const { currentPerf, persist } = window.PerformanceAppChoice;
  const { fetchShield } = window.PerformanceReadings;
  const { _syncSystemButtons, _perfNote } = window.PerformanceDrawn;
  const { powerPlan, perfAction } = window.PerformancePcRequests;

  const AUTO_RESTORE_DELAY_MS = 45000; // grace before an auto session restores (alt-tab safe)
  const AUTO_RESTORE_QUICK_MS = 4000;  // the game actually CLOSED — restore promptly

  // Reflect the persisted "active" state onto the DOM. Safe to call repeatedly.
  function applyState() {
    const p = currentPerf();
    // perf-mode drives the animation/FX pause CSS, so it's gated on that action.
    document.body.classList.toggle('perf-mode', p.active && p.applied.pauseAnimations);
    // perf-active = a performance/optimization session is running at all (manual or
    // auto), regardless of which actions it applied. Heavy live tiles (Browser,
    // Second screen) read this so "pause heavy tiles while … optimizing" works even
    // when the session didn't also pause animations.
    document.body.classList.toggle('perf-active', !!p.active);
    _syncStaleWatch();
    _syncIdleWatch();
    _syncSystemButtons(p);
    // The top bar marker (js/performance/perf-marker.js) and the Settings lines that a
    // session changes listen for this. applyState runs on every settings apply,
    // so it is told only when something they show has changed.
    const sig = [!!p.active, document.body.classList.contains('perf-mode'), p.barAlways].join('|');
    if (sig === state._stateSig) return;
    state._stateSig = sig;
    // Guarded: the widgets-only driver page and the tests run this without one.
    if (typeof CustomEvent === 'function' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('xenon:perf-change', { detail: { active: !!p.active } }));
    }
  }

  // meta: { auto: true } when an ended auto session restores itself.
  async function restore(meta) {
    _cancelAutoRestore();
    const p = currentPerf();
    // Asked first: the server forgets the session's apps when the session ends.
    const shield = p.applied.shield ? await fetchShield() : null;
    const moved = shield && Array.isArray(shield.moved) ? shield.moved.length : 0;
    if (p.savedPowerPlan) {
      try { await powerPlan('POST', p.savedPowerPlan); } catch { /* best effort */ }
    }
    if (p.applied.boostedProc) {
      try { await perfAction({ type: 'setPriority', name: p.applied.boostedProc, level: 'normal' }); } catch { /* best effort */ }
    }
    for (const a of p.closedApps) {
      try { await perfAction({ type: 'launchApp', path: a.path }); } catch { /* ignore */ }
    }
    persist({ active: false, activatedBy: '', autoActivity: '', savedPowerPlan: '', closedApps: [], applied: { pauseAnimations: false, powerPlan: 'none', boostedProc: '', shield: false } });
    applyState();
    if (typeof syncPerformanceControls === 'function') syncPerformanceControls();
    if (typeof setSettingsStatus === 'function') setSettingsStatus('perf_status_restored', 'ok');
    _perfNote({ key: meta && meta.auto ? 'perf_auto_off' : 'perf_status_restored', moved }, 'ok');
  }

  function _scheduleAutoRestore(delayMs = AUTO_RESTORE_DELAY_MS) {
    if (state._autoRestoreTimer) return;
    state._autoRestoreTimer = setTimeout(async () => {
      state._autoRestoreTimer = null;
      const p = currentPerf();
      const cur = state._lastActivity;
      const stillEnabled = cur !== 'other' && p.autoActivities && p.autoActivities[cur];
      if (p.active && p.activatedBy === 'auto' && !stillEnabled) await restore({ auto: true });
    }, delayMs);
  }

  // The long restore grace exists for Alt-Tab: the game is still alive and the
  // user is probably coming back. When the game process is actually GONE,
  // sitting out the rest of it just leaves Performance Mode on for no reason —
  // reschedule the pending restore to fire promptly instead.
  function _expediteAutoRestore() {
    if (!state._autoRestoreTimer) return;
    clearTimeout(state._autoRestoreTimer);
    state._autoRestoreTimer = null;
    _scheduleAutoRestore(AUTO_RESTORE_QUICK_MS);
  }

  // An AUTO session already ends itself: _react() schedules a restore as soon as
  // the activity stops being one the user opted into. A MANUAL one had no end
  // condition at all. You press the button for a game, the game exits, and
  // Performance Mode is still on hours later — animations paused across the
  // whole dashboard, power plan swapped, and nothing on screen saying why.
  //
  // Found on a real install: a session started for `planetcoaster2`, still
  // active with the game long gone. What it looked like from the outside was a
  // broken dashboard, because the only visible symptom is that everything
  // stopped moving. Nobody goes looking in Performance settings for that.
  //
  // The end condition is the one the session itself wrote down: `boostedProc` is
  // the app it was started for. When that app is gone, the reason is gone —
  // whoever started it.
  const STALE_POLL_MS = 5 * 60 * 1000;   // the slow sweep, for a session already stale at load
  const STALE_FIRST_MS = 15000;          // …but ask soon after the dashboard settles
  const STALE_RECHECK_MS = 30000;        // an app that is merely restarting gets a second chance

  // Is the app the session was started for still running?
  //
  // NOT /api/performance/stats. That is a top-40-by-RAM ranking built for the
  // "close these apps" sheet, and absent from it does not mean gone: Windows
  // trims a minimised process's working set hard, so a minimised game drops off
  // the list while still running — and ending the session then would revert the
  // power plan and drop the priority boost UNDER A LIVE GAME, announcing that it
  // had finished. A ranking is not a process list.
  //
  // `isRunning` looks the name up in the whole process table, which is an exact
  // answer, changes nothing and starts no process.
  //
  // Three-valued on purpose. `null` is NOBODY ANSWERED, when the table cannot be
  // read, and must never be read as the app being gone.
  async function _boostedAlive(name) {
    let r = null;
    try { r = await perfAction({ type: 'isRunning', name }); } catch { return null; }
    return r && r.ok ? !!r.running : null;
  }

  async function _checkStale(isRecheck) {
    const p = currentPerf();
    const proc = (p.active && p.applied) ? _procKey(p.applied.boostedProc) : '';
    if (!proc) return;
    const alive = await _boostedAlive(proc);
    if (alive !== false) return;                    // running, or no answer at all
    if (!isRecheck) {
      // Ask once more in a moment: an app that is restarting is briefly absent,
      // and ending somebody's session by mistake is worse than ending it late.
      if (state._staleRecheck) return;
      state._staleRecheck = setTimeout(() => { state._staleRecheck = null; _checkStale(true); }, STALE_RECHECK_MS);
      return;
    }
    // The session may have been ended, or re-pointed at another app, while we
    // were waiting out the recheck.
    const now = currentPerf();
    if (!now.active || _procKey(now.applied && now.applied.boostedProc) !== proc) return;
    await restore({ auto: true });      // toasts, so it is never a silent change
  }

  // Started and stopped from applyState(), which already runs on every settings
  // change and after restore() — so the watch exists only while there is a
  // session with an app to outlive, and stops the moment there is not. Slow on
  // purpose: the game-death signal in onStatus() catches the common case
  // immediately, and this only has to catch a session that was already stale when
  // the dashboard opened.
  function _syncStaleWatch() {
    const p = currentPerf();
    const want = !!(p.active && p.applied && p.applied.boostedProc);
    if (want && !state._stalePoll) {
      // Gated on the tab being visible, like every other periodic client work:
      // with nobody looking, a session ending a few minutes later costs nothing.
      const tick = () => { if (!nobodyLooking()) _checkStale(false); };
      setTimeout(tick, STALE_FIRST_MS);
      state._stalePoll = setInterval(tick, STALE_POLL_MS);
    } else if (!want && state._stalePoll) {
      clearInterval(state._stalePoll);
      state._stalePoll = null;
      if (state._staleRecheck) { clearTimeout(state._staleRecheck); state._staleRecheck = null; }
    }
  }

  // The stale check above needs `boostedProc`, and a session started with no game
  // or opted-in activity in the foreground ("Migliora" on the System tile, while
  // just using the desktop) never records one. That session had no end at all.
  // Found on a real install: on for days, with the Browser tile paused and the
  // power plan on High the whole time. So it ends after IDLE_END_MS in which no
  // game ran and no activity the user opted into was in front. Anything that
  // counts as busy restarts the count, so it never ends under a game.
  const IDLE_END_MS = 20 * 60 * 1000;
  const IDLE_TICK_MS = 60 * 1000;

  async function _idleTick() {
    const p = currentPerf();
    if (!_idleEligible(p)) return;
    if (_busyNow(p)) { state._idleSince = 0; return; }
    const now = Date.now();
    if (!state._idleSince) { state._idleSince = now; return; }
    // A surface nobody is looking at leaves this to the one that is: restore()
    // relaunches closed apps, and two surfaces doing it at once would do it twice.
    if (nobodyLooking()) return;
    if (now - state._idleSince < IDLE_END_MS) return;
    state._idleSince = 0;
    await restore({ auto: true });   // toasts, so it is never a silent change
  }

  function _syncIdleWatch() {
    const want = _idleEligible(currentPerf());
    if (want && !state._idleTimer) {
      state._idleSince = 0;
      state._idleTimer = setInterval(() => { _idleTick().catch(() => {}); }, IDLE_TICK_MS);
      _idleTick().catch(() => {});
    } else if (!want && state._idleTimer) {
      clearInterval(state._idleTimer);
      state._idleTimer = null;
      state._idleSince = 0;
    }
  }

  window.PerformanceSessionEnd = {
    applyState, restore, _scheduleAutoRestore, _expediteAutoRestore, _checkStale,
  };
})();
