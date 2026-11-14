'use strict';
// The staged update handed to the applier outside this process: whether one is already under
// way, the applier that could not be started, the environment it is given, and the start
// itself.

function makeApply({
  spawn, f, platform, isPosix, applierPath, psExe, supported, _installWritable, staged, suRun,
}) {
  function applyInFlight() {
    return !!suRun.applyStartedAt && Date.now() - suRun.applyStartedAt < 5 * 60 * 1000;
  }
  // The applier could not even be started (interpreter missing, blocked by an
  // antivirus): nothing is running, so the guard must not hold a retry off for
  // five minutes, and the failure must not become an uncaught exception that
  // apply()'s caller never hears about.
  function onSpawnError(err) {
    suRun.applyStartedAt = 0;
    suRun.lastSpawnError = String((err && (err.code || err.message)) || 'spawn_failed');
  }

  // opts.quiet  — do not open the dashboard in a browser when done (the
  //               automatic updater runs while nobody is at the PC).
  // opts.hidden — no console window for the launcher (Windows). Only honoured
  //               when no UAC prompt is needed, which is the only case the
  //               automatic updater applies in.
  // opts.port   — the port this server listens on, so the applier stops and
  //               waits for THIS server (XENON_PORT), not whatever holds 3030.
  //
  // quiet and port travel as ENVIRONMENT variables (XENON_UPDATE_QUIET,
  // XENON_PORT), never as script parameters. Mid-update the applier hands the
  // rest of the work to the copy of itself the update just installed, and that
  // copy may be a different version: an unknown parameter makes PowerShell
  // refuse to start it, while an unknown variable is simply ignored.
  function applierEnv(o, port) {
    const env = { ...process.env };
    if (port) env.XENON_PORT = String(port);
    if (o.quiet) env.XENON_UPDATE_QUIET = '1';
    else delete env.XENON_UPDATE_QUIET;
    return env;
  }

  function apply(opts) {
    const o = opts || {};
    if (!supported()) return { ok: false, error: 'unsupported' };
    if (suRun.preparing) return { ok: false, error: 'prepare_in_flight' };
    if (!staged()) return { ok: false, error: 'not_staged' };
    // A second apply while one is running (double-tap on the touchscreen, two
    // open dashboards) would spawn a second applier whose "backup" snapshots a
    // half-swapped tree — the exact mixed state rollback exists to prevent.
    // The window is generous: a real apply either kills this process (server
    // restart) or fails within a few minutes, and a stale flag self-expires.
    if (applyInFlight()) {
      return { ok: false, error: 'apply_in_flight' };
    }
    suRun.applyStartedAt = Date.now();
    suRun.lastSpawnError = '';
    const port = Number.isInteger(o.port) && o.port > 0 && o.port < 65536 ? o.port : 0;
    // macOS/Linux need none of the Windows launch dance below. There is no UAC
    // and the install root is per-user. (On Windows, detaching is exactly what
    // must NOT happen: a console-less powershell silently exits without running
    // the script.) What they do need is for the applier to OUTLIVE the server it
    // is about to stop, and that differs between them:
    //
    // - macOS: `detached: true` calls setsid(), which is enough.
    // - Linux: setsid does NOT escape a cgroup, so an applier spawned by a
    //   systemd user unit stays inside it and `systemctl stop` would kill it
    //   mid-swap. `systemd-run --user` puts it in a transient unit of its own,
    //   which is the only real escape. `--collect` reaps that unit when it ends.
    //   Where systemd-run does not exist the backend is almost certainly not
    //   under systemd either, so the plain detached spawn is the right fallback;
    //   the applier re-checks its own cgroup before touching systemctl.
    if (isPosix) {
      let file = '/bin/bash';
      let args = [applierPath];
      const env = applierEnv(o, port);
      if (platform === 'linux') {
        const systemdRun = ['/usr/bin/systemd-run', '/bin/systemd-run']
          .find((p) => { try { return f.existsSync(p); } catch { return false; } });
        if (systemdRun) {
          file = systemdRun;
          // A transient unit does NOT inherit the caller's environment; the
          // two variables have to be handed to it explicitly.
          const setenv = [];
          if (env.XENON_PORT) setenv.push('--setenv=XENON_PORT=' + env.XENON_PORT);
          if (env.XENON_UPDATE_QUIET) setenv.push('--setenv=XENON_UPDATE_QUIET=1');
          args = ['--user', '--collect', '--quiet', '--unit=xenon-update',
            '--description=Xenon self-update applier', ...setenv, '/bin/bash', applierPath];
        }
      }
      const child = spawn(file, args, { detached: true, stdio: 'ignore', env });
      if (child && typeof child.on === 'function') child.on('error', onSpawnError);
      if (child && typeof child.unref === 'function') child.unref();
      return { ok: true, started: true };
    }
    // The applier always re-launches itself as an independent -Worker child, which
    // breaks out of Node's kill-on-close job (Windows "silent breakaway") and so
    // survives this server being stopped mid-swap. We only choose HOW it relaunches:
    //
    // - Install dir is WRITABLE (common case): pass -NoElevate. The applier
    //   relaunches via a plain Start-Process (no 'runas'), so NO UAC prompt ever
    //   appears. This is the fix for multi-monitor / touchscreen setups (e.g. the
    //   Xeneon Edge): the UAC secure-desktop prompt lands on the primary monitor
    //   and can be impossible to find or tap.
    // - Install dir is NOT writable: the applier relaunches elevated via
    //   ShellExecute 'runas' (one UAC prompt) so it can write a protected location.
    //
    // The launcher here must keep a console (so NOT detached): a console-less
    // powershell (DETACHED_PROCESS) silently exits without running the script.
    const noElevate = _installWritable();
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', applierPath];
    if (noElevate) args.push('-NoElevate');
    // windowsHide still gives powershell a console (SW_HIDE), unlike DETACHED,
    // so the script runs; it only stops a window flashing up on a PC nobody is
    // using. Never with an elevation prompt pending: UAC needs its own window.
    const child = spawn(psExe, args, { windowsHide: !!(o.hidden && noElevate), stdio: 'ignore', env: applierEnv(o, port) });
    if (child && typeof child.on === 'function') child.on('error', onSpawnError);
    if (child && typeof child.unref === 'function') child.unref();
    return { ok: true, started: true };
  }

  return { applyInFlight, apply };
}

module.exports = { makeApply };
