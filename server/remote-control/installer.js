'use strict';

const defaultRunner = require('./runner');

const PACKAGES = {
  sunshine: 'LizardByte.Sunshine',
  tailscale: 'Tailscale.Tailscale',
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

  async function isInstalled(name) {
    const id = resolveId(name);
    const r = await runner.run('winget', ['list', '-e', '--id', id]);
    return r.code === 0 && r.stdout.includes(id);
  }

  async function install(name) {
    const id = resolveId(name);
    return runner.runElevated('winget', [
      'install', '-e', '--id', id,
      '--silent', '--accept-package-agreements', '--accept-source-agreements',
    ]);
  }

  return { isWingetAvailable, isInstalled, install };
}

module.exports = { createInstaller, PACKAGES };
