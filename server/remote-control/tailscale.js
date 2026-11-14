'use strict';

const fs = require('node:fs');
const nodePath = require('node:path');
const defaultRunner = require('./runner');
const { UAC_CANCELLED } = require('./runner');

const { EXE_CANDIDATES, exeCandidates, EXE } = require('./tailscale-exe.js');

const {
  isPermissionError, NO_BACKEND, normalizeDnsName, parseStatus, safeAuthUrl, certsEnabledFor,
} = require('./tailscale-status.js');

function createTailscale({ runner = defaultRunner, exe = null, exists = null, platform = process.platform } = {}) {
  const fileExists = typeof exists === 'function'
    ? exists
    : (p) => fs.promises.access(p, fs.constants.F_OK).then(() => true, () => false);

  // An explicit `exe` is the caller's answer and is not second-guessed (the tests
  // rely on that). Otherwise: the first candidate that is actually on disk.
  const candidates = exe ? [exe] : exeCandidates(platform);
  let found = '';   // cached hit; an install does not move afterwards
  // Windows has no daemon-socket owner to be, so a refusal there is never this.
  const needsOperatorPossible = platform !== 'win32';

  async function resolveExe() {
    if (found) return found;
    for (const p of candidates) {
      if (await Promise.resolve(fileExists(p)).catch(() => false)) { found = p; return p; }
    }
    return '';
  }

  async function getStatus() {
    const path_ = await resolveExe();
    // Nothing to ask. Spawning at a path that does not exist only produces an
    // ENOENT to translate back into the same answer.
    if (!path_) {
      return {
        installed: false, running: false, connected: false, backendState: '',
        ip: '', dnsName: '', certsEnabled: false, needsOperator: false, authUrl: '',
      };
    }
    const r = await runner.run(path_, ['status', '--json'])
      .catch(() => ({ code: 1, stdout: '', stderr: '' }));
    const s = parseStatus(r.stdout);
    return {
      // Kept first, and kept named `installed`, for the existing remote-control
      // state shape — only its ANSWER changed, from "the command worked" to the
      // question it was always meant to ask.
      installed: true,
      running: s.running,
      connected: s.connected,
      backendState: s.backendState,
      ip: s.ip,
      dnsName: s.dnsName,
      certsEnabled: certsEnabledFor(s.certDomains, s.dnsName),
      // Installed and present, but this user may not talk to the daemon. Only
      // meaningful when the command did NOT answer — a daemon that replied has
      // evidently let us in for READS.
      //
      // Which is not the same as writes, and that gap is why this flag alone is
      // not enough: measured on Fedora 43, tailscaled's socket is srw-rw-rw-, so
      // `status --json` answers happily for any user while `up` comes back
      // "Access denied: checkprefs access denied". A machine that needs the
      // operator grant therefore looks perfectly healthy here. startLogin()
      // reports the refusal it actually meets, and the setup acts on that.
      needsOperator: needsOperatorPossible && !s.running && isPermissionError(r.stderr || r.stdout),
      authUrl: s.authUrl,
    };
  }

  /** The resolved CLI path, or '' — exported so callers can name it in a message. */
  async function exePath() { return resolveExe(); }

  /**
   * Make the current user tailscaled's operator, so `up` and `cert` stop being
   * refused. One elevated command, the same one Tailscale's own error message
   * tells people to type.
   *
   * This exists for the machine where Tailscale was ALREADY installed — by the
   * user, by their distribution, by anything that was not us. The install path
   * folds this into its own elevation, but that path never runs there, and
   * printing a command at somebody is the thing this port is trying to stop
   * doing. Windows has no operator concept, so there it is a no-op rather than
   * a spawn.
   */
  async function grantOperator(user) {
    if (!needsOperatorPossible) return { ok: false, reason: 'not_applicable' };
    const name = String(user || '');
    // Interpolated into an elevated command line: anything that is not the
    // shape of a username is refused rather than escaped.
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return { ok: false, reason: 'bad_user' };
    const path_ = await resolveExe();
    if (!path_) return { ok: false, reason: 'not_installed' };

    const r = await runner.runElevated(path_, ['set', `--operator=${name}`])
      .catch(() => ({ code: 1, stderr: '' }));
    if (r.code === 0) return { ok: true };
    // 1223 is a declined UAC prompt on Windows and a dismissed polkit dialog on
    // Linux — the user saying no, which is not a failure to report as one.
    if (r.code === UAC_CANCELLED) return { ok: false, reason: 'cancelled' };
    return { ok: false, reason: 'failed', error: String(r.stderr || '').slice(0, 400) };
  }

  /**
   * Start the daemon when it is installed and simply not running.
   *
   * This is the Windows twin of `grantOperator`: one elevated command that fixes
   * a machine which is otherwise fine. It is a real state, not a theoretical one
   * — measured on a Windows 11 box where the service sat `Manual` and `Stopped`
   * after an install, so `status --json` could not answer at all and every
   * question above it came back "not connected" for a reason that had nothing to
   * do with signing in.
   *
   * `sc start` returns as soon as the service reports START_PENDING, so `ok`
   * here means "the request was accepted", not "the daemon is up"; the caller
   * polls `getStatus().running` for the second half. The startup TYPE is left
   * alone on purpose — a service set to Manual may well have been set that way
   * by the user, and changing it is a decision they did not ask us to make.
   *
   * macOS is deliberately absent. There the daemon belongs to the app bundle or
   * to Homebrew and those two shapes need different commands, so guessing would
   * be worse than saying so: `not_applicable` is what the panel turns into "open
   * the Tailscale app".
   */
  const SERVICE_START = {
    win32: ['sc.exe', ['start', 'Tailscale']],
    linux: ['systemctl', ['start', 'tailscaled']],
  };

  async function startService() {
    const spec = SERVICE_START[platform];
    if (!spec) return { ok: false, reason: 'not_applicable' };
    const r = await runner.runElevated(spec[0], spec[1], { timeoutMs: 120000 })
      .catch(() => ({ code: 1, stderr: '' }));
    if (r.code === 0) return { ok: true };
    // 1056 is ERROR_SERVICE_ALREADY_RUNNING. Somebody else won the race — which
    // is the outcome we wanted, so it is not a failure to report as one.
    if (r.code === 1056) return { ok: true };
    if (r.code === UAC_CANCELLED) return { ok: false, reason: 'cancelled' };
    return { ok: false, reason: 'failed', error: String(r.stderr || '').slice(0, 400) };
  }

  /**
   * Start the GUI client, for the daemon that is up and has no backend.
   *
   * The one that actually bites on Windows, and the one nothing else can see.
   * Measured on Windows 11: with the service Running and no `tailscale-ipn.exe`,
   * `status --json` answers normally and reports NO_BACKEND indefinitely, the
   * Tailscale Tunnel adapter is Up, `debug prefs` shows a real profile with
   * `WantRunning: true`, `debug daemon-logs` prints nothing at all, and
   * `tailscale up` cannot move any of it. Starting the tray app took the same
   * machine to `Running` in under three seconds, already signed in — no browser,
   * no account prompt. So this is not a sign-in problem wearing a disguise; the
   * backend simply had no client to start it.
   *
   * Deliberately NOT elevated: the tray app belongs to the user's session, and
   * an elevated one would be a different session with a different profile. That
   * is also why it cannot go through `runElevated` for convenience.
   *
   * Linux is absent because tailscaled needs no client there — the systemd unit
   * starts the backend itself, so a NO_BACKEND that persists means something
   * else and starting a GUI would be a guess.
   */
  const GUI_EXE = 'tailscale-ipn.exe';

  async function startClient() {
    const path_ = await resolveExe();
    if (!path_) return { ok: false, reason: 'not_installed' };
    if (platform === 'darwin') {
      // There the app IS the daemon, so `open` is both the install shape and
      // the remedy. It returns as soon as it has launched, so `run` is right.
      const r = await runner.run('open', ['-a', 'Tailscale'], { timeoutMs: 15000 })
        .catch(() => ({ code: 1 }));
      return r.code === 0 ? { ok: true } : { ok: false, reason: 'failed' };
    }
    if (platform !== 'win32') return { ok: false, reason: 'not_applicable' };
    // Derived from the CLI we already resolved rather than from a second
    // hardcoded path: the two ship in the same directory, and an install that
    // moved would otherwise be half-found.
    // Windows path rules, not the host's. `platform` is an injected option — that
    // is what lets this module be exercised off Windows — but nodePath follows
    // the machine it runs on, and POSIX reads
    // "C:\Program Files\Tailscale\tailscale.exe" as one long filename with no
    // directory in it, so the GUI "beside the CLI" came out as a bare
    // "tailscale-ipn.exe" in the working directory. On Windows itself the two are
    // the same object, so nothing changes where it matters.
    const win = nodePath.win32;
    const gui = win.join(win.dirname(path_), GUI_EXE);
    if (!(await Promise.resolve(fileExists(gui)).catch(() => false))) {
      return { ok: false, reason: 'not_installed' };
    }
    if (!runner.spawnDetached) return { ok: false, reason: 'not_applicable' };
    const r = await runner.spawnDetached(gui, []).catch(() => ({ ok: false }));
    return r && r.ok ? { ok: true } : { ok: false, reason: 'failed', error: (r && r.error) || '' };
  }

  // Fire-and-observe: `tailscale up` apre il browser per il login OAuth e puo
  // restare in attesa. Timeout breve per non bloccare il server; il login reale
  // prosegue in background e lo stato si rileva poi via getStatus() (polling).
  //
  // `needsOperator` is classified HERE and not only in getStatus() because this
  // is where the refusal actually happens. `up` writes preferences, and writing
  // is what the daemon guards; reading is not. On the machine this was measured
  // on, the exact answer is:
  //
  //   Access denied: checkprefs access denied
  //   To not require root, use 'sudo tailscale set --operator=$USER' once.
  //
  // Left unclassified, the caller polls a login that can never begin and ends
  // up reporting a five-minute `login_timeout` — the one message that sends
  // somebody to look at their network instead of at one `sudo` command.
  //
  // A timeout is deliberately NOT a refusal: `up` blocking is the normal shape
  // of a successful login waiting on the browser.
  async function startLogin() {
    const path_ = await resolveExe();
    if (!path_) return { code: 1, stdout: '', stderr: 'tailscale not found', needsOperator: false, authUrl: '' };
    const r = await runner.run(path_, ['up'], { timeoutMs: 5000 })
      .catch(() => ({ code: 1, stdout: '', stderr: '', timedOut: false }));

    // `up` prints the sign-in URL and keeps waiting, so the 5s timeout above is
    // the NORMAL path and the URL is in the output we just collected. Grab it
    // there first; tailscaled also publishes it in `status --json`, which is the
    // fallback for a run that timed out before printing.
    const printed = safeAuthUrl((/(https:\/\/login\.tailscale\.com\/\S+)/
      .exec(`${r.stdout || ''}\n${r.stderr || ''}`) || [])[1]);
    const authUrl = printed || (await getStatus().catch(() => ({}))).authUrl || '';

    // Open it. On Windows the Tailscale GUI client does this itself, which is
    // exactly why nobody noticed it was missing everywhere else. Best-effort:
    // if no browser opens, the panel still shows the link.
    if (authUrl) openUrl(authUrl);

    return {
      ...r,
      authUrl,
      needsOperator: needsOperatorPossible && r.code !== 0 && !r.timedOut
        && isPermissionError(r.stderr || r.stdout),
    };
  }

  // The desktop's own "open this link" command. Never a shell, and only ever
  // called with a URL that matched AUTH_URL_RE.
  function openUrl(url) {
    const [file, args] = platform === 'darwin' ? ['open', [url]]
      : platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
    Promise.resolve(runner.run(file, args, { timeoutMs: 10000 })).catch(() => {});
  }

  /**
   * Provision or renew the Let's Encrypt certificate tailscaled holds for this
   * machine's MagicDNS name, writing it to the two given paths.
   *
   * Renewal is the same command: tailscaled reuses a certificate that is still
   * fresh and fetches a new one near expiry, so a caller may run this on a timer
   * without rate-limit risk. Errors are returned, never thrown, and `reason`
   * separates the ONE case the user can fix from everything else because they
   * need different sentences: `certs_disabled` means the tailnet's HTTPS
   * Certificates switch is off (a 500 from the control plane, not a local
   * fault), anything else is a local failure worth reporting verbatim.
   *
   * `needs_operator` is the second such case, and it only exists off Windows: on
   * Linux the daemon's socket is root-owned, so the command is refused until the
   * user runs `sudo tailscale set --operator=$USER` once. Reported as its own
   * reason rather than folded into `failed`, because the remedy is one command
   * and the panel can print it.
   */
  async function cert(fqdn, { certFile, keyFile, timeoutMs = 90000 } = {}) {
    const name = normalizeDnsName(fqdn);
    if (!name) return { ok: false, reason: 'bad_name', error: 'not a MagicDNS name' };
    if (!certFile || !keyFile) return { ok: false, reason: 'bad_args', error: 'cert/key path required' };
    const path_ = await resolveExe();
    if (!path_) return { ok: false, reason: 'failed', error: 'tailscale not found' };
    const r = await runner.run(path_, ['cert', '--cert-file', certFile, '--key-file', keyFile, name], { timeoutMs })
      .catch((e) => ({ code: 1, stdout: '', stderr: String((e && e.message) || e) }));
    if (r.code === 0) return { ok: true, reason: '', error: '' };
    const msg = String(r.stderr || r.stdout || '').trim();
    const disabled = /does not support getting TLS certs|HTTPS is not enabled/i.test(msg);
    if (disabled) return { ok: false, reason: 'certs_disabled', error: msg.slice(0, 400) };
    // Only off Windows. There is no operator concept there, so a refusal is an
    // ordinary local failure — most likely the cert path not being writable —
    // and answering it with "run sudo tailscale set --operator" would be advice
    // for a different operating system.
    if (needsOperatorPossible && isPermissionError(msg)) {
      return { ok: false, reason: 'needs_operator', error: msg.slice(0, 400) };
    }
    return { ok: false, reason: 'failed', error: msg.slice(0, 400) };
  }

  return { getStatus, startLogin, cert, exePath, grantOperator, startService, startClient };
}

module.exports = {
  createTailscale,
  TAILSCALE_EXE: EXE,
  EXE_CANDIDATES,
  exeCandidates,
  isPermissionError,
  parseStatus,
  NO_BACKEND,
  normalizeDnsName,
  certsEnabledFor,
};
