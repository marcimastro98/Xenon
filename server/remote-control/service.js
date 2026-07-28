'use strict';

const defaultRunner = require('./runner');

const SERVICE = 'SunshineService';
const TAILSCALE_SERVICE = 'Tailscale';

/**
 * Controlla il servizio Windows SunshineService.
 * - isRunning: lettura non elevata tramite sc.exe (non richiede UAC).
 * - stop / start: operazioni elevate tramite runner.runElevated (un solo prompt UAC).
 *   Il comando PS viene passato come -EncodedCommand (base64 UTF-16LE) per evitare
 *   problemi di quoting attraverso il doppio livello Start-Process -> powershell.
 *
 * Le funzioni "managed" (setStartup/startManaged/stopManaged) agiscono su ENTRAMBI
 * i servizi del controllo remoto (Sunshine + Tailscale) e servono alla modalita'
 * "avvio su richiesta": di default i loro installer si registrano ad avvio
 * Automatico e restano sempre attivi anche quando il remoto non si usa.
 */
// Off Windows the same two services are a different SHAPE, and the difference
// is the whole reason this file needed porting rather than translating.
//
// Sunshine is the USER's service there — `systemctl --user`, or `brew services`
// on a Mac — so starting, stopping and enabling it needs no password at all.
// Tailscale is the SYSTEM's (tailscaled), and touching it would. So the
// on-demand mode manages only Sunshine off Windows: it is the service this
// feature installed, the one the toggle is about, and the only one that can be
// managed without a prompt. Stopping the user's VPN because they turned a
// dashboard switch off would be doing something nobody asked for.
const POSIX_UNIT = 'sunshine';

function createService({
  runner = defaultRunner,
  name = SERVICE,
  tailscaleName = TAILSCALE_SERVICE,
  platform = process.platform,
  unit = POSIX_UNIT,
} = {}) {
  if (platform !== 'win32') return createPosixService({ runner, platform, unit });

  // Servizi gestiti dall'avvio-su-richiesta. Un try/catch per servizio (sotto)
  // fa si' che un servizio assente (es. Tailscale non installato) non blocchi l'altro.
  const managed = [name, tailscaleName];

  function elevatedPs(inner) {
    const encoded = Buffer.from(inner, 'utf16le').toString('base64');
    return runner.runElevated('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
  }

  // Costruisce un blocco PS che applica i comandi dati a ogni servizio gestito,
  // isolando ciascuno in un try/catch cosi' un fallimento non interrompe gli altri.
  function perManaged(cmds) {
    const list = managed.map((s) => `'${String(s).replace(/'/g, "''")}'`).join(',');
    const body = cmds.map((c) => `try { ${c} -Name $s -ErrorAction Stop } catch {}`).join('; ');
    return `foreach ($s in ${list}) { ${body} }`;
  }

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

  // Avvio su richiesta: imposta il tipo di avvio di ENTRAMBI i servizi e li porta
  // subito nello stato coerente, in un unico prompt UAC.
  //   onDemand=true  -> Manual + Stop  (non partono col boot, spenti ora)
  //   onDemand=false -> Automatic + Start (comportamento di default ripristinato)
  // Stop-Service usa -Force (ferma anche eventuali dipendenti); Start-Service no.
  async function setStartup(onDemand) {
    const type = onDemand ? 'Manual' : 'Automatic';
    const transition = onDemand ? 'Stop-Service -Force' : 'Start-Service';
    const r = await elevatedPs(perManaged([`Set-Service -StartupType ${type}`, transition]));
    return r.code === 0;
  }

  // Avvia/ferma i servizi gestiti per la sessione (usate quando il remoto viene
  // abilitato/disabilitato mentre l'avvio-su-richiesta e' attivo). Un solo UAC.
  async function startManaged() {
    const r = await elevatedPs(perManaged(['Start-Service']));
    return r.code === 0;
  }
  async function stopManaged() {
    const r = await elevatedPs(perManaged(['Stop-Service -Force']));
    return r.code === 0;
  }

  return { isRunning, stop, start, setStartup, startManaged, stopManaged, serviceName: name };
}

/**
 * Linux and macOS. Same contract as the Windows one, no elevation anywhere:
 * every command here acts on a service the user already owns.
 */
function createPosixService({ runner, platform, unit }) {
  const isMac = platform === 'darwin';

  // `systemctl --user is-active` exits 0 only for "active"; brew prints a table
  // whose row for the service says `started`.
  async function isRunning() {
    if (isMac) {
      const r = await runner.run('brew', ['services', 'list']).catch(() => null);
      if (!r || r.code !== 0) return false;
      const line = String(r.stdout || '').split('\n').find((l) => l.trim().startsWith(unit));
      return !!line && /\bstarted\b/i.test(line);
    }
    const r = await runner.run('systemctl', ['--user', 'is-active', unit]).catch(() => null);
    return !!r && r.code === 0;
  }

  function ctl(verb) {
    return isMac
      ? runner.run('brew', ['services', verb, unit])
      : runner.run('systemctl', ['--user', verb, unit]);
  }

  async function stop() { const r = await ctl('stop').catch(() => null); return !!r && r.code === 0; }
  async function start() { const r = await ctl('start').catch(() => null); return !!r && r.code === 0; }

  /**
   * On-demand start. Windows flips a service's StartupType; the user-session
   * equivalent is enable/disable, and it applies to Sunshine only — see the note
   * at the top of this file about not touching the user's VPN.
   *
   * brew has no enable/disable split: `brew services start` IS the persistent
   * form and `stop` removes it, so the transition is the whole operation there.
   */
  async function setStartup(onDemand) {
    if (isMac) return onDemand ? stop() : start();
    const verb = onDemand ? 'disable' : 'enable';
    const r = await runner.run('systemctl', ['--user', verb, unit]).catch(() => null);
    if (!r || r.code !== 0) return false;
    return onDemand ? stop() : start();
  }

  async function startManaged() { return start(); }
  async function stopManaged() { return stop(); }

  return { isRunning, stop, start, setStartup, startManaged, stopManaged, serviceName: unit };
}

module.exports = {
  createService, createPosixService,
  SUNSHINE_SERVICE: SERVICE, TAILSCALE_SERVICE, POSIX_UNIT,
};
