'use strict';

const defaultRunner = require('./runner');

const PACKAGES = {
  sunshine: 'LizardByte.Sunshine',
  tailscale: 'Tailscale.Tailscale',
  // Signed (MIT) Indirect Display Driver for the Second-screen feature — the only
  // external dependency; capture/encode lives in the Xenon Helper we already ship.
  vdd: 'VirtualDrivers.Virtual-Display-Driver',
};

function createInstaller({ runner = defaultRunner } = {}) {
  function resolveId(name) {
    const id = PACKAGES[name];
    if (!id) throw new Error(`Pacchetto sconosciuto: ${name}`);
    return id;
  }

  async function isWingetAvailable() {
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
    const r = await runner.run('winget', ['list', '-e', '--id', id]);
    const value = r.code === 0 && r.stdout.includes(id);
    installedCache.set(name, { value, at: Date.now() });
    return value;
  }

  async function install(name) {
    const id = resolveId(name);
    const result = await runner.runElevated('winget', [
      'install', '-e', '--id', id,
      '--silent', '--accept-package-agreements', '--accept-source-agreements',
    ]);
    installedCache.delete(name);
    return result;
  }

  return { isWingetAvailable, isInstalled, install };
}

module.exports = { createInstaller, PACKAGES };
