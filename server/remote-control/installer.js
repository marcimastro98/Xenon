'use strict';

const os = require('node:os');
const defaultRunner = require('./runner');

// The account the server runs as, which is the one that needs to be able to
// drive tailscaled. Sanitised to the shell-safe shape a username has anyway,
// because this value is interpolated into an elevated command line; anything
// unexpected yields '' and the operator step is simply skipped.
function currentUser() {
  let name = '';
  try { name = os.userInfo().username || ''; } catch { name = process.env.USER || ''; }
  return /^[A-Za-z0-9._-]+$/.test(name) ? name : '';
}

const PACKAGES = {
  sunshine: 'LizardByte.Sunshine',
  tailscale: 'Tailscale.Tailscale',
  // Signed (MIT) Indirect Display Driver for the Second-screen feature — the only
  // external dependency; capture/encode lives in the Xenon Helper we already ship.
  // Windows-only for good: an Indirect Display Driver is a public, documented
  // Windows API with no counterpart elsewhere. macOS exposes no public virtual
  // display API at all, and on Linux it needs the evdi kernel module AND a
  // compositor willing to add an output — which GNOME's Wayland session is not.
  vdd: 'VirtualDrivers.Virtual-Display-Driver',
};

// Linux: the same two packages, per package manager. The subcommand differs
// enough between families that a template is less readable than the list.
//
// VERIFIED: dnf, on the Fedora 43 machine this port was built against, where
// `tailscale` is 1.94.2 in Fedora's OWN repositories — no third-party repo to
// add, so the install is one prompt and nothing else. The other three are the
// same package under the same name in the same role, written from the
// distributions' conventions and NOT exercised here; they degrade to the manual
// instructions if the install fails, never to a wrong silent success.
const LINUX_PM = {
  dnf: (pkg) => ['dnf', 'install', '-y', pkg],
  'apt-get': (pkg) => ['apt-get', 'install', '-y', pkg],
  zypper: (pkg) => ['zypper', '--non-interactive', 'install', pkg],
  pacman: (pkg) => ['pacman', '-S', '--noconfirm', pkg],
};

const LINUX_PACKAGES = {
  // Installing the package is not enough, twice over, and both extras ride in
  // the SAME elevation — one prompt for the whole thing rather than three,
  // which is the difference between one click and a chore.
  //
  //  · the daemon does not start by itself, so the panel would report
  //    `not_running` immediately after a successful install;
  //  · and the user still could not drive it. tailscaled allows READS from
  //    anyone (its socket is srw-rw-rw-) but guards writes, so `tailscale up`
  //    comes back "Access denied: checkprefs access denied" while everything
  //    else looks healthy. The operator grant is the documented one-time fix,
  //    and doing it here means the user never meets the error at all.
  //
  // %USER% is substituted with the account the server runs as — never with
  // anything that came from a request.
  tailscale: {
    pkg: 'tailscale',
    service: 'tailscaled',
    post: ['tailscale set --operator=%USER%'],
  },
  // Sunshine is not in the distributions' repos, but IS on Flathub as the
  // project's own published build. Flatpak is tried first for exactly that
  // reason, and because it is the only route here that can install without
  // touching the system at all.
  sunshine: { pkg: 'sunshine', flatpak: 'dev.lizardbyte.app.Sunshine' },
};

// macOS: Homebrew or nothing. There is no system package manager to fall back
// on, and `brew` is the user's tool — if they do not have it, Xenon says so
// rather than installing a package manager behind their back.
//
// NOT VERIFIED ON A MAC. Both entries were checked against the upstream
// sources rather than guessed — `tailscale` is in homebrew-core and ships both
// the CLI and tailscaled; `sunshine` is NOT in core and needs LizardByte's own
// tap, which an earlier version of this table got wrong — but no Mac has run
// them. Every failure here lands on the manual-instructions path.
const MAC_PACKAGES = {
  // `brew services` needs root to install a daemon into /Library/LaunchDaemons,
  // which is why this one step is elevated while `brew install` is not.
  tailscale: { brew: 'tailscale', service: 'tailscaled' },
  sunshine: { brew: 'sunshine', tap: 'LizardByte/homebrew' },
};

function createInstaller({ runner = defaultRunner, platform = process.platform } = {}) {
  // Every platform has an honest counterpart to winget, and the earlier port was
  // wrong to say otherwise: pkexec is what UAC is — a graphical prompt owned by
  // the desktop, not a sudo call smuggled out of a dashboard — and flatpak can
  // install without touching the system at all. What stays true is that Xenon
  // never installs a package manager, so if the machine has none of these the
  // installer does nothing and says so, and the panel prints the exact command.
  const isWin = platform === 'win32';
  const isMac = platform === 'darwin';

  function resolveId(name) {
    const id = PACKAGES[name];
    if (!id) throw new Error(`Pacchetto sconosciuto: ${name}`);
    return id;
  }

  // `sh -c command -v` rather than `which`, which is not installed everywhere;
  // sh is. Every name passed here comes from the tables above, never from a
  // request, so there is nothing to escape.
  const whichCache = new Map();
  async function which(bin) {
    if (whichCache.has(bin)) return whichCache.get(bin);
    const r = await runner.run('sh', ['-c', `command -v ${bin} 2>/dev/null`]).catch(() => null);
    const hit = r && r.code === 0 ? String(r.stdout || '').trim().split('\n')[0] : '';
    whichCache.set(bin, hit);
    return hit;
  }

  // First package manager present wins; the order is the table's.
  let pmCache;
  async function linuxPm() {
    if (pmCache !== undefined) return pmCache;
    for (const name of Object.keys(LINUX_PM)) {
      if (await which(name)) { pmCache = name; return pmCache; }
    }
    pmCache = '';
    return pmCache;
  }

  // A flatpak install still needs a remote to install FROM. Fedora ships one
  // configured; a machine without it would otherwise fail at the last step with
  // a message about refs rather than about what to do.
  async function flatpakReady(name) {
    const spec = LINUX_PACKAGES[name];
    if (!spec || !spec.flatpak || !(await which('flatpak'))) return false;
    const r = await runner.run('flatpak', ['remotes', '--columns=name']).catch(() => null);
    return !!r && r.code === 0 && /flathub/i.test(r.stdout || '');
  }

  /**
   * Whether install() can do anything for `name` on this machine. Called with
   * no argument it answers for the platform in general, which is what the older
   * callers meant.
   */
  async function canInstall(name) {
    if (isWin) return isWingetAvailable();
    if (isMac) return !!(await which('brew')) && !!(MAC_PACKAGES[name] || !name);
    if (name && await flatpakReady(name)) return true;
    if (name && !LINUX_PACKAGES[name]) return false;
    return !!(await which('pkexec')) && !!(await linuxPm());
  }

  async function isWingetAvailable() {
    if (!isWin) return false;
    const r = await runner.run('winget', ['--version']);
    return r.code === 0;
  }

  // `winget list` costa centinaia di ms di CPU e gira sul poll periodico di
  // /remote/status. Lo stato "installato" non cambia da solo: un esito positivo
  // resta valido per la vita del processo, uno negativo viene riverificato dopo
  // un TTL (l'utente puo' installare il tool fuori dalla dashboard). install()
  // invalida la voce cosi' la verifica post-install e' sempre reale.
  const installedCache = new Map(); // name -> { value, at }
  const NOT_INSTALLED_TTL_MS = 60 * 1000;

  async function isInstalled(name) {
    const id = resolveId(name);
    const hit = installedCache.get(name);
    if (hit && (hit.value || Date.now() - hit.at < NOT_INSTALLED_TTL_MS)) return hit.value;
    const value = isWin ? await installedWin(id) : await installedPosix(name);
    installedCache.set(name, { value, at: Date.now() });
    return value;
  }

  async function installedWin(id) {
    const r = await runner.run('winget', ['list', '-e', '--id', id]);
    return r.code === 0 && r.stdout.includes(id);
  }

  // The binary on PATH is the answer that matters — it is what the rest of Xenon
  // actually calls. Asking a package manager instead would miss anything the
  // user installed by hand, and report "not installed" for something plainly
  // sitting there.
  async function installedPosix(name) {
    const spec = (isMac ? MAC_PACKAGES : LINUX_PACKAGES)[name];
    if (!spec) return false;
    if (await which(spec.brew || spec.pkg || name)) return true;
    // A flatpak is not on PATH under its own name; ask flatpak instead.
    if (!isMac && spec.flatpak && (await which('flatpak'))) {
      const r = await runner.run('flatpak', ['info', spec.flatpak]).catch(() => null);
      return !!r && r.code === 0;
    }
    return false;
  }

  async function install(name) {
    const id = resolveId(name);
    const result = isWin ? await installWin(id)
      : isMac ? await installMac(name)
        : await installLinux(name);
    installedCache.delete(name);
    whichCache.clear();
    return result;
  }

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
    const r = await runner.run('brew', ['install', spec.brew], { timeoutMs: 15 * 60 * 1000 });
    if (r.code !== 0) return r;

    // The daemon is the exception. Installing a LaunchDaemon writes outside the
    // brew prefix, so this — and only this — raises the admin dialog. Its
    // failure is not the install's failure: the package is there either way,
    // and the setup re-probes.
    if (spec.service) {
      await runner.runElevated('brew', ['services', 'start', spec.brew], { timeoutMs: 5 * 60 * 1000 })
        .catch(() => null);
    }
    return r;
  }

  async function installLinux(name) {
    const spec = LINUX_PACKAGES[name];
    if (!spec) return manual('no Linux recipe for this package');

    // Flatpak first where it exists: it is the project's own build and the only
    // route that does not modify the system.
    if (await flatpakReady(name)) {
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

  return { isWingetAvailable, canInstall, isInstalled, install };
}

module.exports = { createInstaller, PACKAGES, LINUX_PACKAGES, MAC_PACKAGES, LINUX_PM };
