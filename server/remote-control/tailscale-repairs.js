'use strict';
// The three repairs of a Tailscale that is installed and not answering: the right to manage it
// given to the user, the daemon started, and the tray client started, the first two with one
// question for the administrator's password.

const nodePath = require('node:path');
const { UAC_CANCELLED } = require('./runner.js');

function makeRepairs({ runner, platform, fileExists, needsOperatorPossible, resolveExe }) {
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

  return { grantOperator, startService, startClient };
}

module.exports = { makeRepairs };
