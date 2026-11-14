// What the updater knows about versions: which of two is newer, the version the user dismissed or
// skipped, whether an update is waiting, and what it remembers about bringing the app's shell up to
// the engine's version.
'use strict';

(() => {
  const DISMISS_KEY = 'xenon.update.dismissed'; // last version the user dismissed

  const SHELL_TRIED_KEY = 'xenon.update.shellTried'; // last app version an update of the shell was started for
  const SHELL_PENDING_KEY = 'xenon.update.shellPending'; // an update tapped by hand still owes the app its half
  // How long after that tap the app half may still start on its own (see
  // shellCatchUpPlan).
  const SHELL_RESUME_MS = 15 * 60 * 1000;

  // Strip any leading "v" so version strings compare/render consistently
  // (a "v"-prefixed version from the server must never render as "vv3.2.4").
  const stripV = (s) => String(s || '').replace(/^v/i, '');

  // Minimal semver triple compare: true only when a is strictly newer than b.
  // Deliberately PERMISSIVE with junk (unlike the fail-closed server/semver.js):
  // a malformed segment coerces to 0, so a garbled caps.shellVersion still
  // compares — the orchestrator would rather offer a shell update once too
  // often than never on exactly the broken installs that need it.
  function semverNewer(a, b) {
    const pa = stripV(a).split('.');
    const pb = stripV(b).split('.');
    for (let i = 0; i < 3; i++) {
      const x = parseInt(pa[i], 10) || 0;
      const y = parseInt(pb[i], 10) || 0;
      if (x !== y) return x > y;
    }
    return false;
  }

  // Running inside the Tauri native shell? The shell sets __XENON_NATIVE__ very
  // early (its init script) and Tauri injects window.isTauri. On the native app
  // the in-app updater owns the update flow (a signed download + relaunch — see
  // native-bridge.js and the Rust shell). The web "Download" button here would
  // only bounce the user to the GitHub release page in an external browser,
  // which is NOT an update — the exact bug users hit. So on native every update
  // affordance routes to the in-app installer instead of GitHub.
  function isNativeShell() {
    return window.__XENON_NATIVE__ === true || window.isTauri === true
      || !!(window.XenonNative && window.XenonNative.isNative);
  }

  // "Skip this version" — the stored value is ONE version, never a flag, so the
  // next release always prompts again. Normalized through stripV because the two
  // surfaces that write it disagree on the prefix: the server's /update/check
  // may report "v4.9.2" while the Tauri updater hands the native toast "4.9.2",
  // and an unnormalized compare would make each surface blind to the other's
  // skip.
  function dismissedVersion() {
    try { return stripV(localStorage.getItem(DISMISS_KEY) || ''); } catch { return ''; }
  }

  function rememberDismissed(version) {
    try { localStorage.setItem(DISMISS_KEY, stripV(version)); } catch { /* ignore */ }
  }

  function isVersionSkipped(version) {
    const v = stripV(version);
    return !!v && dismissedVersion() === v;
  }

  // null = this browser cannot remember anything, which closes every automatic
  // path: without the record of a try, a failing update would be tried forever.
  function readShellTried() {
    try { return stripV(localStorage.getItem(SHELL_TRIED_KEY) || ''); } catch { return null; }
  }

  function rememberShellTried(version) {
    if (!version) return;
    try { localStorage.setItem(SHELL_TRIED_KEY, stripV(version)); } catch { /* readShellTried() is null then */ }
  }

  // Written when the user taps Update and both halves are due, before anything
  // restarts. Read once by the next page and dropped: it only speaks for that
  // start. The applier's own result is no help here, it is written after the
  // relaunched app is already asking.
  function rememberShellPending(version) {
    try {
      localStorage.setItem(SHELL_PENDING_KEY, JSON.stringify({ to: stripV(version), at: Date.now() }));
    } catch { /* the pill still offers the app half */ }
  }

  function takeShellPending() {
    try {
      const raw = localStorage.getItem(SHELL_PENDING_KEY);
      if (raw === null) return null;
      localStorage.removeItem(SHELL_PENDING_KEY);
      const p = JSON.parse(raw);
      return p && typeof p === 'object' ? { to: stripV(p.to), at: Number(p.at) } : null;
    } catch { return null; }
  }

  // This shell is older than the dashboard it shows, and can replace itself (an
  // Arch package cannot: pacman owns it). An older shell without the caps says
  // nothing about its version, so nothing is assumed here.
  function shellBehind(info) {
    if (!isNativeShell() || !info || !info.current) return false;
    const caps = window.__XENON_NATIVE_CAPS__ || {};
    if (caps.shellSelfUpdate === false || !caps.shellVersion) return false;
    return semverNewer(info.current, caps.shellVersion);
  }

  // What to do about a shell that is behind, from plain values so it can be
  // tested on its own:
  //   'now'    the user tapped Update a moment ago, the dashboard half is done
  //            and the app half never ran. On macOS that is every such update:
  //            the applier ends by relaunching the whole app (the backend is
  //            its child), which closes the page that was about to start the
  //            shell's update. This finishes what they asked for.
  //   'quiet'  the dashboard is current, so the app can follow it at a quiet
  //            moment, if updates are automatic here (catchUpShell asks).
  //   ''       nothing automatic; the pill and the shell's own toast offer it.
  // The dashboard always goes first, and each version is tried once: a try
  // that failed waits for a tap instead of restarting the app over and over.
  function shellCatchUpPlan(s) {
    if (!s || !s.behind || s.updateAvailable) return '';
    const target = stripV(s.current);
    if (!target || s.tried === null || s.tried === target) return '';
    const p = s.pending;
    const at = p ? Number(p.at) : NaN;
    if (p && stripV(p.to) === target && Number.isFinite(at)
      && s.now >= at && s.now - at <= SHELL_RESUME_MS) return 'now';
    // The shell's updater installs the newest release, so only follow when that
    // IS the dashboard's version: never land the app on a release the dashboard
    // has not taken yet (it waits a day for a reason). A skipped version stays
    // skipped.
    if (!s.skipped && s.latest && stripV(s.latest) === target) return 'quiet';
    return '';
  }

  // Single source of truth: when an update is available, show the red dot on the
  // topbar Settings button, a count on the About row and a key on the About page, and
  // HIDE the now-redundant "Check for updates" button. When up to date, the opposite.
  // After an update the next check reports nothing new, so the dot clears itself.
  // An app left behind its dashboard counts too (shellBehind): the dashboard
  // reading "up to date" was exactly how a stale shell went unnoticed.
  function hasUpdate(info) {
    return !!(info && (info.updateAvailable || (info.latest && shellBehind(info))));
  }

  window.UpdateVersions = {
    stripV, semverNewer, isNativeShell, rememberDismissed, isVersionSkipped, readShellTried,
    rememberShellTried, rememberShellPending, takeShellPending, shellBehind, shellCatchUpPlan,
    hasUpdate,
  };
})();
