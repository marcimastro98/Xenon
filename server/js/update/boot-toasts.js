// The toasts shown once at startup about what went wrong while no page was watching: a startup
// entry switched off or repaired, and an app update that did not finish.
'use strict';

(() => {
  const { stripV, semverNewer } = window.UpdateVersions;
  const { tr } = window.UpdateFailureWords;

  const SHELL_ERR_KEY = 'xenon.update.shellErrPending'; // shell update failed right before a reload

  // At startup, curated "What's New" for the running version takes precedence over
  // the "update available" nudge (you can only act on one popup at a time, and the
  // update dot/pill stays visible either way). Whichever doesn't auto-open is still
  // reachable — the update modal from the Settings pill, and What's New from the
  // version number in Settings.
  // Failures that happened while no page was watching: an apply that rolled
  // back after the page was closed (the applier's persisted result), or a shell
  // update that errored right before the reload (flag set by runShellPhase).
  // Shown once, then acknowledged.
  // ── Will Xenon still be here after the next sign-in? ───────────────────────
  // The engine checks its own per-logon startup task and puts back the three
  // conditions the installer owns (see server/install/startup-task.js). Two things are
  // worth a word here, and nothing else is: a repair, because the app changed
  // something on this PC without being asked; and a task that is switched OFF,
  // because that one is the user's to turn back on and until they do, Xenon
  // will simply not be there tomorrow — with nothing on screen to say why. That
  // silence is what this exists for: it was reported as days of features going
  // wrong, by someone whose engine kept being stopped.
  //
  // Once per load, and never on a healthy install.
  async function surfaceStartupTaskNotice() {
    let st = null;
    try { st = await fetch('/api/startup-task').then((r) => r.json()); } catch { return; }
    if (!st || !st.ok || !st.found || !window.XenonToast) return;
    const problems = Array.isArray(st.problems) ? st.problems : [];
    const repaired = Array.isArray(st.repaired) ? st.repaired : [];
    if (problems.includes('disabled')) {
      window.XenonToast.show({
        type: 'warning',
        duration: 0,   // sticky: this is the one notice that costs the user their next session
        title: tr('startup_task_off_title', 'Xenon will not start at your next sign-in'),
        message: tr('startup_task_off_msg', 'Its startup entry has been switched off. Xenon never does that itself: Windows and cleanup or antivirus tools can. Turn it back on in Task Manager, under Startup apps, where it is listed as Xenon.'),
      });
    } else if (repaired.length) {
      window.XenonToast.show({
        type: 'info',
        duration: 10000,
        title: tr('startup_task_fixed_title', 'Xenon repaired its own startup entry'),
        message: tr('startup_task_fixed_msg', 'Something had changed the conditions it starts under: it would have stopped on battery, or been stopped after a few days. Those are back as they were installed.'),
      });
    }
  }

  function surfaceShellFailure(info) {
    try {
      if (localStorage.getItem(SHELL_ERR_KEY)) {
        localStorage.removeItem(SHELL_ERR_KEY);
        // The flag records "the shell update produced no outcome in time", not
        // a proven failure — an install can simply outlast the watchdog. If the
        // shell is in fact current now, the update landed: say nothing.
        const caps = window.__XENON_NATIVE_CAPS__ || {};
        const shellCurrent = !!(info && info.latest && caps.shellVersion
          && !semverNewer(stripV(info.latest), caps.shellVersion));
        if (!shellCurrent && window.XenonToast) {
          window.XenonToast.show({
            type: 'error',
            duration: 12000,
            title: tr('update_failed_title', 'Aggiornamento non riuscito'),
            message: tr('update_native_shell_error', 'L’app non è riuscita a completare il proprio aggiornamento. La dashboard è aggiornata: riproverà al prossimo avvio.'),
          });
        }
      }
    } catch { /* localStorage unavailable */ }
  }

  window.UpdateBootToasts = { SHELL_ERR_KEY, surfaceStartupTaskNotice, surfaceShellFailure };
})();
