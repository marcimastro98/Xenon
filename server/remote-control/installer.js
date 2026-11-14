'use strict';

const defaultRunner = require('./runner');
require('./service');

const {
  WIN_SERVICES, PACKAGES, LINUX_PM, LINUX_PACKAGES, MAC_PACKAGES,
} = require('./installer-packages.js');

const { makeInstallSteps } = require('./installer-steps.js');

const { makeSunshineSteps } = require('./installer-sunshine.js');

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
  // sh is. Every name passed here comes from the tables of installer-packages.js, never from a
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

  const {
    manual, installWin, installMac, installLinux,
  } = makeInstallSteps({ runner, which, linuxPm, flatpakReady });

  const {
    sunshineVersion, upgradeSunshine,
  } = makeSunshineSteps({ runner, isWin, isMac, which, manual });

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
