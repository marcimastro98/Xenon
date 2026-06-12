'use strict';

const defaultRunner = require('./runner');

const SERVICE = 'SunshineService';

/**
 * Controlla il servizio Windows SunshineService.
 * - isRunning: lettura non elevata tramite sc.exe (non richiede UAC).
 * - stop / start: operazioni elevate tramite runner.runElevated (un solo prompt UAC).
 *   Il comando PS viene passato come -EncodedCommand (base64 UTF-16LE) per evitare
 *   problemi di quoting attraverso il doppio livello Start-Process -> powershell.
 */
function createService({ runner = defaultRunner, name = SERVICE } = {}) {
  async function isRunning() {
    // sc.exe e' un eseguibile nativo (~10ms): questa lettura gira sul poll
    // periodico di /remote/status, quindi spawnare powershell.exe (~300ms di
    // avvio CLR) a ogni giro pesava su CPU e temperature. I nomi di stato di
    // sc.exe (RUNNING/STOPPED) non sono localizzati; servizio assente = exit
    // code 1060, quindi code 0 + RUNNING e' un controllo sufficiente.
    const r = await runner.run('sc.exe', ['query', name]);
    return r.code === 0 && /RUNNING/i.test(r.stdout);
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
