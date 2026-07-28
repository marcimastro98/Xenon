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
// Sunshine's Flathub build — the only route on a distribution that has no
// sunshine package, which includes Fedora.
const FLATPAK_ID = 'dev.lizardbyte.app.Sunshine';
// The transient unit Xenon starts the flatpak under, so the session manager
// owns it and it can be queried and stopped by name.
const TRANSIENT_UNIT = 'xenon-sunshine';

function createService({
  runner = defaultRunner,
  name = SERVICE,
  tailscaleName = TAILSCALE_SERVICE,
  platform = process.platform,
  unit = POSIX_UNIT,
  flatpakId,
  fsImpl,
  homeDir,
} = {}) {
  if (platform !== 'win32') {
    return createPosixService({ runner, platform, unit, flatpakId, fsImpl, homeDir });
  }

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
function createPosixService({
  runner, platform, unit,
  flatpakId = FLATPAK_ID,
  fsImpl = require('node:fs'),
  homeDir = null,
} = {}) {
  flatpakId = flatpakId || FLATPAK_ID;
  fsImpl = fsImpl || require('node:fs');
  const isMac = platform === 'darwin';

  // Which of the three shapes this machine has. Decided once and cached: an
  // install does not change form underneath us.
  //
  // The flatpak shape is not an edge case — it is the ONLY route on Fedora,
  // which has no sunshine package at all, and the Flathub build ships NO
  // systemd unit. Assuming `systemctl --user … sunshine` there would report
  // "not running" forever and every start would fail, on the one distribution
  // this port was built against.
  let shapeCache;
  async function shape() {
    if (shapeCache) return shapeCache;
    if (isMac) { shapeCache = 'brew'; return shapeCache; }
    const u = await runner.run('systemctl', ['--user', 'list-unit-files', `${unit}.service`])
      .catch(() => null);
    if (u && u.code === 0 && new RegExp(`\\b${unit}\\.service`).test(u.stdout || '')) {
      shapeCache = 'systemd';
      return shapeCache;
    }
    const f = await runner.run('flatpak', ['info', flatpakId]).catch(() => null);
    shapeCache = f && f.code === 0 ? 'flatpak' : 'systemd';
    return shapeCache;
  }

  async function isRunning() {
    const s = await shape();
    if (s === 'brew') {
      const r = await runner.run('brew', ['services', 'list']).catch(() => null);
      if (!r || r.code !== 0) return false;
      const line = String(r.stdout || '').split('\n').find((l) => l.trim().startsWith(unit));
      return !!line && /\bstarted\b/i.test(line);
    }
    if (s === 'flatpak') {
      // A flatpak app is not a service: what exists is a running instance.
      const r = await runner.run('flatpak', ['ps', '--columns=application']).catch(() => null);
      return !!r && r.code === 0 && String(r.stdout || '').includes(flatpakId);
    }
    const r = await runner.run('systemctl', ['--user', 'is-active', unit]).catch(() => null);
    return !!r && r.code === 0;
  }

  async function start() {
    const s = await shape();
    if (s === 'brew') return ok(await runner.run('brew', ['services', 'start', unit]).catch(() => null));
    if (s === 'flatpak') {
      // `flatpak run` blocks for as long as Sunshine lives, so running it
      // directly would hang the request until a timeout killed the very thing
      // it just started. systemd-run hands it to the session manager and
      // returns at once; --collect keeps a failed unit from lingering and
      // blocking the next attempt.
      return ok(await runner.run('systemd-run', [
        '--user', '--collect', `--unit=${TRANSIENT_UNIT}`,
        'flatpak', 'run', '--command=sunshine', flatpakId,
      ]).catch(() => null));
    }
    return ok(await runner.run('systemctl', ['--user', 'start', unit]).catch(() => null));
  }

  async function stop() {
    const s = await shape();
    if (s === 'brew') return ok(await runner.run('brew', ['services', 'stop', unit]).catch(() => null));
    if (s === 'flatpak') {
      // Stop the app itself, then the transient unit if we were the one who
      // started it. Either may legitimately not exist, so neither failing alone
      // is a failure.
      const killed = await runner.run('flatpak', ['kill', flatpakId]).catch(() => null);
      const unitStopped = await runner.run('systemctl', ['--user', 'stop', `${TRANSIENT_UNIT}.service`])
        .catch(() => null);
      return ok(killed) || ok(unitStopped);
    }
    return ok(await runner.run('systemctl', ['--user', 'stop', unit]).catch(() => null));
  }

  const ok = (r) => !!r && r.code === 0;

  /**
   * On-demand start. Windows flips a service's StartupType; the user-session
   * equivalent is enable/disable, and it applies to Sunshine only — see the
   * note at the top of this file about not touching the user's VPN.
   *
   * brew has no enable/disable split: `brew services start` IS the persistent
   * form and `stop` removes it, so the transition is the whole operation there.
   *
   * A flatpak has no unit to enable either. Its persistent form is an XDG
   * autostart entry, which is what the desktop actually reads at login — so
   * "always on" writes one and "on demand" removes it.
   */
  async function setStartup(onDemand) {
    const s = await shape();
    if (s === 'brew') return onDemand ? stop() : start();
    if (s === 'flatpak') {
      if (!writeAutostart(!onDemand)) return false;
      return onDemand ? stop() : start();
    }
    const verb = onDemand ? 'disable' : 'enable';
    const r = await runner.run('systemctl', ['--user', verb, unit]).catch(() => null);
    if (!ok(r)) return false;
    return onDemand ? stop() : start();
  }

  // The autostart entry for the flatpak shape. Named for Xenon rather than for
  // Sunshine so it can never be mistaken for — or clobber — one the user or the
  // package put there themselves.
  function autostartPath() {
    const home = homeDir || process.env.HOME || '';
    return `${home}/.config/autostart/xenon-sunshine.desktop`;
  }

  function writeAutostart(enabled) {
    const file = autostartPath();
    try {
      if (!enabled) {
        try { fsImpl.unlinkSync(file); } catch { /* already absent is the goal */ }
        return true;
      }
      fsImpl.mkdirSync(file.replace(/\/[^/]+$/, ''), { recursive: true });
      fsImpl.writeFileSync(file, [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Sunshine (Xenon)',
        'Comment=Started by Xenon remote control',
        `Exec=flatpak run --command=sunshine ${flatpakId}`,
        'X-GNOME-Autostart-enabled=true',
        '',
      ].join('\n'));
      return true;
    } catch {
      return false;
    }
  }

  async function startManaged() { return start(); }
  async function stopManaged() { return stop(); }

  return { isRunning, stop, start, setStartup, startManaged, stopManaged, serviceName: unit, shape };
}

module.exports = {
  createService, createPosixService,
  SUNSHINE_SERVICE: SERVICE, TAILSCALE_SERVICE, POSIX_UNIT,
  SUNSHINE_FLATPAK_ID: FLATPAK_ID, TRANSIENT_UNIT,
};
