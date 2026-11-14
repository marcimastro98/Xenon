'use strict';
// How a package is installed on each system: winget on Windows, Homebrew on macOS, and flatpak
// or the distribution's package manager on Linux.

const { currentUser } = require('./installer-user.js');
const { LINUX_PM, LINUX_PACKAGES, MAC_PACKAGES } = require('./installer-packages.js');

function makeInstallSteps({ runner, which, linuxPm, flatpakReady }) {
  function manual(why) {
    return { code: 1, stdout: '', stderr: why, reason: 'manual_install_required' };
  }

  function installWin(id) {
    return runner.runElevated('winget', [
      'install', '-e', '--id', id,
      '--silent', '--accept-package-agreements', '--accept-source-agreements',
    ]);
  }

  async function installMac(name) {
    const spec = MAC_PACKAGES[name];
    if (!spec || !(await which('brew'))) return manual('Homebrew is not installed');

    // Sunshine is not in homebrew-core; it lives in LizardByte's own tap, and
    // `brew install` on an untapped formula fails with "No available formula".
    // Tapping twice is harmless.
    if (spec.tap) await runner.run('brew', ['tap', spec.tap], { timeoutMs: 5 * 60 * 1000 });

    // Deliberately NOT elevated: brew refuses to run under sudo, and on a Mac
    // it owns its own prefix, so there is nothing to elevate for.
    const r = await runner.run('brew',
      ['install', ...(spec.cask ? ['--cask'] : []), spec.brew],
      { timeoutMs: 15 * 60 * 1000 });
    if (r.code !== 0) return r;

    // The daemon is the exception. Installing a LaunchDaemon writes outside the
    // brew prefix, so this — and only this — raises the admin dialog. Its
    // failure is not the install's failure: the package is there either way,
    // and the setup re-probes.
    //
    // NOT elevated any more, on purpose. Homebrew's prefix (/opt/homebrew) is
    // owned by the user, so running `brew` as root means root executes Ruby and
    // binaries that any program running as the user could have rewritten — a
    // local privilege escalation dressed up as a password prompt (and brew
    // itself refuses to run as root for the same reason). runner.runElevated
    // now refuses user-owned binaries outright. So the service is started as
    // the user; if tailscaled needs root on this Mac, the panel re-probes and
    // the user gets the documented `sudo brew services start` hint instead.
    if (spec.service) {
      const sr = await runner.run('brew', ['services', 'start', spec.brew], { timeoutMs: 5 * 60 * 1000 })
        .catch(() => null);
      if (!sr || sr.code !== 0) {
        return { ...r, serviceHint: `sudo brew services start ${spec.brew}` };
      }
    }
    return r;
  }

  async function installLinux(name) {
    const spec = LINUX_PACKAGES[name];
    if (!spec) return manual('no Linux recipe for this package');

    // Flatpak first where it exists: it is the project's own build and the only
    // route that does not modify the system. Unless the caller needs a package
    // that can see the host filesystem — see `preferNative` above.
    if (!spec.preferNative && await flatpakReady(name)) {
      const r = await runner.run('flatpak',
        ['install', '-y', '--noninteractive', 'flathub', spec.flatpak],
        { timeoutMs: 15 * 60 * 1000 });
      if (r.code === 0) return r;
      // Fall through to the distribution package rather than give up: a filtered
      // Flathub remote can carry the app in search and still refuse the install.
    }

    if (!(await which('pkexec'))) return manual('pkexec is not available');
    const pm = await linuxPm();
    if (!pm) return manual('no supported package manager found');

    // ONE elevation for every step. Split up, the user authenticates three times
    // for what they experienced as a single button; and a daemon left disabled,
    // or a user left without the operator grant, both read as a broken feature
    // right after an install that reported success.
    //
    // `post` is joined with `;` and not `&&` on purpose: it is follow-up
    // configuration, so a failure there must not make the install itself report
    // failure — the package IS installed, and the setup re-probes anyway.
    const parts = [LINUX_PM[pm](spec.pkg).join(' ')];
    if (spec.service) parts.push(`systemctl enable --now ${spec.service}`);
    // A step whose substitution came up empty is dropped, not run blank:
    // `tailscale set --operator=` would clear the grant rather than give it.
    const user = currentUser();
    const post = (spec.post || [])
      .filter((p) => !p.includes('%USER%') || user)
      .map((p) => `; ${p.replace('%USER%', user)}`);
    const cmd = parts.join(' && ') + post.join('');
    return runner.runElevated('sh', ['-c', cmd], { timeoutMs: 15 * 60 * 1000 });
  }

  return { manual, installWin, installMac, installLinux };
}

module.exports = { makeInstallSteps };
