'use strict';

const fs = require('node:fs');
const defaultRunner = require('./runner');
const { UAC_CANCELLED } = require('./runner');

// Where the CLI lives, per platform, in the order we prefer it. Everything below
// this list is platform-neutral: `tailscale status --json`, `up` and `cert` are
// the same commands with the same output on all three, so the path was the only
// thing tying this module to Windows.
//
// macOS has two shapes and both are real: the App Store / standalone app keeps
// its CLI inside the bundle, while Homebrew installs the open-source client into
// its own prefix (Apple Silicon and Intel differ). Linux packages land in
// /usr/bin; the official install script and manual installs use /usr/local/bin.
const EXE_CANDIDATES = {
  win32: ['C:\\Program Files\\Tailscale\\tailscale.exe'],
  darwin: [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
  ],
  linux: ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'],
};

function exeCandidates(platform) {
  return EXE_CANDIDATES[platform] || EXE_CANDIDATES.linux;
}

const EXE = EXE_CANDIDATES.win32[0];

// On Linux tailscaled's local API socket is root-owned, so `up` and `cert` fail
// for a normal user until `sudo tailscale set --operator=$USER` is run once. That
// is a real, fixable situation with an exact remedy, and it must not be reported
// as "Tailscale is broken" — nor may Xenon paper over it by reaching for sudo,
// which would put a password prompt behind a toggle in a dashboard. So it gets
// its own reason and the UI prints the command.
const PERMISSION_RE = /access denied|permission denied|must be run as root|operator|Operation not permitted/i;
function isPermissionError(msg) {
  return PERMISSION_RE.test(String(msg || ''));
}

// A MagicDNS name of this machine, e.g. `mypc.tail1234.ts.net`. This value ends
// up as an ACCEPTED Host header on the HTTPS door (see remote-access.js), so it
// is shape-validated here even though it comes from the local tailscaled rather
// than from the wire — the codebase validates where data ENTERS, and a name that
// will gate requests is exactly that kind of boundary.
const DNS_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Trailing-dot-stripped, lowercased, validated — or '' when it is not a name. */
function normalizeDnsName(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/\.$/, '');
  return s.length <= 253 && DNS_NAME_RE.test(s) ? s : '';
}

/**
 * Pure parser for `tailscale status --json`, exported for the tests.
 *
 * `running` vs `installed` is the distinction the old version collapsed: it
 * reported `installed: false` whenever the command failed, so a machine with
 * Tailscale installed and its service merely STOPPED was indistinguishable from
 * one that never had it — and those two states need opposite instructions from
 * the UI ("install it" vs "start it"). Installation is a file check now; this
 * function only answers what the daemon said. With the daemon down the CLI
 * prints a plain-text error instead of JSON, which is why the JSON parse rather
 * than the exit code is the test.
 */
function parseStatus(stdout) {
  let data = null;
  try { data = JSON.parse(String(stdout || '')); } catch { data = null; }
  if (!data || typeof data !== 'object' || typeof data.BackendState !== 'string') {
    return { running: false, connected: false, ip: '', dnsName: '', certDomains: [] };
  }
  const self = (data.Self && typeof data.Self === 'object') ? data.Self : {};
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
  return {
    running: true,
    connected: data.BackendState === 'Running',
    // The v4 address. The v6 one is equally real, but every URL we hand a person
    // has to be typeable and QR-scannable, and a bracketed v6 literal is neither.
    ip: ips.find((v) => typeof v === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(v)) || '',
    dnsName: normalizeDnsName(self.DNSName),
    // null until HTTPS certificates are enabled for the whole tailnet in the
    // admin console — a per-TAILNET switch nothing on this machine can flip, so
    // the UI has to say so precisely instead of reporting a generic failure.
    certDomains: Array.isArray(data.CertDomains) ? data.CertDomains.filter((d) => typeof d === 'string') : [],
  };
}

/** Whether this tailnet will actually issue a certificate for `fqdn`. */
function certsEnabledFor(certDomains, fqdn) {
  const want = normalizeDnsName(fqdn);
  if (!want) return false;
  return (certDomains || []).some((d) => normalizeDnsName(d) === want);
}

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
        installed: false, running: false, connected: false,
        ip: '', dnsName: '', certsEnabled: false, needsOperator: false,
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
    if (!path_) return { code: 1, stdout: '', stderr: 'tailscale not found', needsOperator: false };
    const r = await runner.run(path_, ['up'], { timeoutMs: 5000 })
      .catch(() => ({ code: 1, stdout: '', stderr: '', timedOut: false }));
    return {
      ...r,
      needsOperator: needsOperatorPossible && r.code !== 0 && !r.timedOut
        && isPermissionError(r.stderr || r.stdout),
    };
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

  return { getStatus, startLogin, cert, exePath, grantOperator };
}

module.exports = {
  createTailscale,
  TAILSCALE_EXE: EXE,
  EXE_CANDIDATES,
  exeCandidates,
  isPermissionError,
  parseStatus,
  normalizeDnsName,
  certsEnabledFor,
};
