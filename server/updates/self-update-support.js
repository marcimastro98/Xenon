'use strict';
// Whether this install can update itself and how: a git checkout, the reason it cannot, whether
// the install folder can be written, whether the update needs the administrator, and whether
// the shell updates without asking.

const path = require('node:path');

function makeSupport({ root, f, platform, isPosix, applierPath }) {
  function isGitCheckout() {
    try { return f.existsSync(path.join(root, '.git')); } catch { return false; }
  }

  // Auto-update needs the external applier script present and must not run on a
  // dev checkout (git). The helper exe / node version don't matter here.
  //
  // The platform test is not redundant with the applierPath one: BOTH appliers
  // are tracked files, so both exist in every checkout — including on a platform
  // where neither the applier nor the archive extractor could run. Reporting
  // unsupported on anything else keeps the flow fail-closed (the dashboard
  // offers a download link instead of an in-place update) rather than letting
  // apply() spawn an interpreter that isn't on this machine.
  // WHY it is unsupported, or '' when it is not. A bare boolean is the answer to
  // a question nobody was asking: an install that cannot update itself looks, to
  // the person holding it, exactly like an update button that does nothing, and
  // "supported: false" in the status told a supporter and me equally little.
  // Each value names a different fix — reinstall over a dev checkout, restore a
  // file (a .ps1 that copies into the install root is the sort of thing an
  // antivirus quarantines), or there is no applier for this OS at all.
  function unsupportedReason() {
    if (platform !== 'win32' && !isPosix) return 'unsupported_platform';
    try {
      if (isGitCheckout()) return 'git_checkout';
      if (!f.existsSync(applierPath)) return 'no_applier';
    } catch { return 'no_applier'; }
    return '';
  }

  function supported() {
    return unsupportedReason() === '';
  }

  // True when the current user can write the install root — i.e. the swap needs
  // no admin rights (the common case: Xenon unzipped into a user-writable folder
  // like Desktop/Downloads, not under Program Files). Probing with a throwaway
  // file is cheaper and more honest than guessing from the path.
  function _installWritable() {
    const probe = path.join(root, '.xenon-update-write-test');
    try {
      f.writeFileSync(probe, '');
      f.rmSync(probe, { force: true });
      return true;
    } catch { return false; }
  }

  // Would applying need a UAC prompt? (Windows only: POSIX installs are per-user.)
  // Nobody can answer a prompt that appears while the PC is idle, so the
  // automatic updater leaves such installs to the manual button.
  function needsElevation() {
    return platform === 'win32' && !_installWritable();
  }

  // Can the native app replace ITSELF with nobody at the PC? On Windows it is a
  // per-user NSIS install that the shell's updater runs in passive mode: no UAC,
  // nothing to answer. On macOS the updater asks for an administrator password
  // whenever it cannot move the app bundle (a standard account, a bundle someone
  // else owns, App Management), and it asks from the app's main thread, so the
  // window freezes until somebody answers; a Linux .deb or .rpm asks through
  // pkexec. Those installs update the app on the user's own tap only.
  function shellUpdatesSilently() {
    return platform === 'win32';
  }

  return {
    isGitCheckout, unsupportedReason, supported, _installWritable, needsElevation,
    shellUpdatesSilently,
  };
}

module.exports = { makeSupport };
