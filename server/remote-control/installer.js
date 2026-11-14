'use strict';

const os = require('node:os');
const defaultRunner = require('./runner');
require('./service');

// The account the server runs as, which is the one that needs to be able to
// drive tailscaled. Sanitised to the shell-safe shape a username has anyway,
// because this value is interpolated into an elevated command line; anything
// unexpected yields '' and the operator step is simply skipped.
function currentUser() {
  let name = '';
  try { name = os.userInfo().username || ''; } catch { name = process.env.USER || ''; }
  return /^[A-Za-z0-9._-]+$/.test(name) ? name : '';
}

const {
  WIN_SERVICES, PACKAGES, LINUX_PM, LINUX_PACKAGES, MAC_PACKAGES,
} = require('./installer-packages.js');

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
    const spec = name ? LINUX_PACKAGES[name] : null;
    if (name && !spec) return false;
    if (spec && !spec.preferNative && await flatpakReady(name)) return true;
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
    const value = isWin ? await installedWin(name, id) : await installedPosix(name);
    installedCache.set(name, { value, at: Date.now() });
    return value;
  }

  // Both tools register a service when they install. Reading the service list costs a
  // few ms where `winget list` costs a second of CPU, so winget is left to answer only
  // for what the list does not show.
  async function installedWin(name, id) {
    const service = WIN_SERVICES[name];
    if (service) {
      const s = await runner.run('sc.exe', ['query', service]).catch(() => null);
      if (s && s.code === 0) return true;
    }
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

  // ── Sunshine must be patched before remote control is switched on ─────────
  // CVE-2026-32253 (critical: the web UI / pairing certificate check could be
  // bypassed) and the September 2026 advisories are fixed in v2026.914.233613.
  // An older Sunshine is a remotely reachable desktop-control service with a
  // known bypass, so enabling remote control on top of one is refused.
  //
  // Version sources, in order of reliability: the package manager that
  // installed it (winget / brew / flatpak), then the binary itself —
  // `sunshine --version` logs "Sunshine version: vX.Y.Z" at startup and exits.
  async function sunshineVersion() {
    const pick = (text, re) => {
      const m = String(text || '').match(re);
      return m ? m[1] : '';
    };
    const VER = '(\\d+\\.\\d+\\.\\d+)';
    let v = '';
    if (isWin) {
      const r = await runner.run('winget', ['list', '-e', '--id', PACKAGES.sunshine]).catch(() => null);
      if (r && r.code === 0) v = pick(r.stdout, new RegExp('LizardByte\\.Sunshine\\s+v?' + VER, 'i'));
      if (!v) {
        const b = await runner.run('C:\\Program Files\\Sunshine\\sunshine.exe', ['--version'], { timeoutMs: 15000 }).catch(() => null);
        if (b) v = pick(`${b.stdout}\n${b.stderr}`, new RegExp('version:?\\s*v?' + VER, 'i'));
      }
      return v;
    }
    if (isMac) {
      if (await which('brew')) {
        const r = await runner.run('brew', ['list', '--versions', 'sunshine']).catch(() => null);
        if (r && r.code === 0) v = pick(r.stdout, new RegExp('^sunshine\\s+v?' + VER, 'im'));
      }
    } else if (LINUX_PACKAGES.sunshine.flatpak && await which('flatpak')) {
      const r = await runner.run('flatpak', ['info', LINUX_PACKAGES.sunshine.flatpak]).catch(() => null);
      if (r && r.code === 0) v = pick(r.stdout, new RegExp('^\\s*Version:\\s*v?' + VER, 'im'));
    }
    if (!v) {
      const bin = await which('sunshine');
      if (bin) {
        const b = await runner.run(bin, ['--version'], { timeoutMs: 15000 }).catch(() => null);
        if (b) v = pick(`${b.stdout}\n${b.stderr}`, new RegExp('version:?\\s*v?' + VER, 'i'));
      }
    }
    return v;
  }

  // Upgrade through whichever route installed it. A hand-installed native
  // package on Linux has no route we can drive, so it is left to the user.
  async function upgradeSunshine() {
    if (isWin) {
      return runner.runElevated('winget', [
        'upgrade', '-e', '--id', PACKAGES.sunshine,
        '--silent', '--accept-package-agreements', '--accept-source-agreements',
      ]);
    }
    if (isMac) {
      if (!(await which('brew'))) return manual('Homebrew is not installed');
      // As the user, never elevated: see installMac.
      return runner.run('brew', ['upgrade', 'sunshine'], { timeoutMs: 15 * 60 * 1000 });
    }
    const fp = LINUX_PACKAGES.sunshine.flatpak;
    if (fp && await which('flatpak')) {
      const info = await runner.run('flatpak', ['info', fp]).catch(() => null);
      if (info && info.code === 0) {
        return runner.run('flatpak', ['update', '-y', '--noninteractive', fp], { timeoutMs: 15 * 60 * 1000 });
      }
    }
    return manual('Sunshine was not installed through a package manager Xenon can update');
  }

  /**
   * Resolve { ok: true, version } when Sunshine is absent or at least
   * SUNSHINE_MIN_VERSION (upgrading it first when it is older), otherwise
   * { ok: false, error: 'sunshine_outdated' | 'sunshine_version_unknown', ... }.
   * Callers must not enable remote control on ok:false.
   */
  async function ensureSunshineCurrent() {
    if (!(await isInstalled('sunshine'))) return { ok: true, installed: false, version: '' };
    let version = await sunshineVersion();
    if (version && !versionLess(version, SUNSHINE_MIN_VERSION)) return { ok: true, installed: true, version };
    const up = await upgradeSunshine().catch((e) => ({ code: 1, stderr: String((e && e.message) || e) }));
    installedCache.delete('sunshine');
    whichCache.clear();
    version = await sunshineVersion();
    if (version && !versionLess(version, SUNSHINE_MIN_VERSION)) {
      return { ok: true, installed: true, version, upgraded: true };
    }
    const error = version ? 'sunshine_outdated' : 'sunshine_version_unknown';
    return {
      ok: false,
      error,
      version,
      required: SUNSHINE_MIN_VERSION,
      cancelled: !!(up && up.code === defaultRunner.UAC_CANCELLED),
      message: version
        ? `Sunshine ${version} has known critical vulnerabilities (CVE-2026-32253); update it to ${SUNSHINE_MIN_VERSION} or newer before enabling remote control.`
        : `Could not read the installed Sunshine version; update it to ${SUNSHINE_MIN_VERSION} or newer before enabling remote control.`,
      detail: String((up && up.stderr) || '').slice(0, 400),
    };
  }

  return { isWingetAvailable, canInstall, isInstalled, install, sunshineVersion, ensureSunshineCurrent };
}

const { SUNSHINE_MIN_VERSION, versionLess } = require('./installer-version.js');


module.exports = { createInstaller, PACKAGES, LINUX_PACKAGES, MAC_PACKAGES, LINUX_PM, SUNSHINE_MIN_VERSION, versionLess };
