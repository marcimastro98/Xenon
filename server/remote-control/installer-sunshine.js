'use strict';
// How the version of the installed Sunshine is read on each system, and how an old one is
// upgraded with the package manager that installed it.

const { PACKAGES, LINUX_PACKAGES } = require('./installer-packages.js');

function makeSunshineSteps({ runner, isWin, isMac, which, manual }) {
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

  return { sunshineVersion, upgradeSunshine };
}

module.exports = { makeSunshineSteps };
