'use strict';

const defaultRunner = require('./runner');

const SERVICE = 'SunshineService';

/**
 * Controlla il servizio Windows SunshineService.
 * - isRunning: lettura non elevata tramite Get-Service (non richiede UAC).
 * - stop / start: operazioni elevate tramite runner.runElevated (un solo prompt UAC).
 *   Il comando PS viene passato come -EncodedCommand (base64 UTF-16LE) per evitare
 *   problemi di quoting attraverso il doppio livello Start-Process -> powershell.
 */
function createService({ runner = defaultRunner, name = SERVICE } = {}) {
  async function isRunning() {
    // Get-Service non richiede admin per leggere lo stato.
    const r = await runner.run('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Service -Name '${name}' -ErrorAction SilentlyContinue).Status`,
    ]);
    return r.code === 0 && /Running/i.test(r.stdout);
  }

  async function elevatedServiceCmd(verb) {
    // Stop-Service supporta -Force (ferma anche eventuali servizi dipendenti);
    // Start-Service NON ha il parametro -Force (aggiungerlo fa fallire il comando).
    const force = verb === 'Stop' ? ' -Force' : '';
    const inner = `${verb}-Service -Name '${name}'${force}`;
    const encoded = Buffer.from(inner, 'utf16le').toString('base64');
    const r = await runner.runElevated('powershell', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
    ]);
    return r.code === 0;
  }

  async function stop() { return elevatedServiceCmd('Stop'); }
  async function start() { return elevatedServiceCmd('Start'); }

  return { isRunning, stop, start, serviceName: name };
}

module.exports = { createService, SUNSHINE_SERVICE: SERVICE };
