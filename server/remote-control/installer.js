'use strict';

const defaultRunner = require('./runner');

const PACKAGES = {
  sunshine: 'LizardByte.Sunshine',
  tailscale: 'Tailscale.Tailscale',
  // Signed (MIT) Indirect Display Driver for the Second-screen feature — the only
  // external dependency; capture/encode lives in the Xenon Helper we already ship.
  vdd: 'VirtualDrivers.Virtual-Display-Driver',
};

function createInstaller({ runner = defaultRunner, platform = process.platform } = {}) {
  // winget is the whole automation story here, and it is Windows'. There is no
  // honest equivalent to substitute: Homebrew and apt are not present on every
  // machine, they are the user's tool rather than ours, and driving a package
  // manager with sudo from a dashboard toggle is not a thing Xenon should do.
  //
  // So off Windows this installer installs NOTHING and says so, and the callers
  // that can still work with an already-installed package (the Tailscale door)
  // ask `canInstall()` and explain the one manual step instead of offering a
  // button that cannot work. `isInstalled` keeps answering, because "is it
  // already here" is a question worth asking on every platform.
  const canAutoInstall = platform === 'win32';

  function resolveId(name) {
    const id = PACKAGES[name];
    if (!id) throw new Error(`Pacchetto sconosciuto: ${name}`);
    return id;
  }

  /** Whether install() can do anything at all on this machine. */
  async function canInstall() {
    return canAutoInstall && (await isWingetAvailable());
  }

  async function isWingetAvailable() {
    if (!canAutoInstall) return false;
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
    // Off Windows there is no registry of "what winget put here" to consult, and
    // guessing from a package manager we did not use would be worse than not
    // answering. The callers that matter probe the executable itself.
    if (!canAutoInstall) return false;
    const hit = installedCache.get(name);
    if (hit && (hit.value || Date.now() - hit.at < NOT_INSTALLED_TTL_MS)) return hit.value;
    const r = await runner.run('winget', ['list', '-e', '--id', id]);
    const value = r.code === 0 && r.stdout.includes(id);
    installedCache.set(name, { value, at: Date.now() });
    return value;
  }

  async function install(name) {
    const id = resolveId(name);
    if (!canAutoInstall) return { code: 1, stdout: '', stderr: 'manual install required', reason: 'manual_install_required' };
    const result = await runner.runElevated('winget', [
      'install', '-e', '--id', id,
      '--silent', '--accept-package-agreements', '--accept-source-agreements',
    ]);
    installedCache.delete(name);
    return result;
  }

  return { isWingetAvailable, canInstall, isInstalled, install };
}

module.exports = { createInstaller, PACKAGES };
