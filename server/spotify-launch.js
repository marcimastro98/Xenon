'use strict';
// Start the Spotify desktop app on this computer, minimized when the user asked
// for it, so the Spotify tile can turn "Spotify is closed" into music playing on
// the PC with one tap. Asked for on Discord.
//
// Every launch is an argv array of fixed values: nothing the browser sends
// reaches a command line. The platform choice lives here, not at the call site.
//
// Minimized is honoured where the app allows it:
// - Windows: Spotify.exe takes --minimized, the flag its own autostart uses.
//   The classic install has it in %APPDATA%; the Microsoft Store one exposes the
//   same name as an execution alias, which passes the flag on (checked on the
//   Store build 1.306, Oct 2026). With neither present, the spotify: link opens
//   the app normally.
// - macOS: `open -g -j` starts the app hidden, in the background.
// - Linux: the client has no such option, so it opens normally and the setting
//   is not offered (canStartMinimized).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// How long a short-lived opener (open, xdg-open, PowerShell) may run before we
// stop waiting for its exit code. It is left running, never killed: on some
// desktops xdg-open stays alive as the parent of the app it started.
const LAUNCH_SETTLE_MS = 5000;

// The spotify: link through the shell's protocol handler. A fixed string.
const WIN_PROTOCOL_ARGS = ['-NoProfile', '-NonInteractive', '-Command',
  "try{[void][System.Diagnostics.Process]::Start([System.Diagnostics.ProcessStartInfo]@{FileName='spotify:';UseShellExecute=$true})}catch{exit 1}"];

function windowsExeCandidates(env) {
  const out = [];
  if (env && env.APPDATA) out.push(path.win32.join(env.APPDATA, 'Spotify', 'Spotify.exe'));
  if (env && env.LOCALAPPDATA) out.push(path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'Spotify.exe'));
  return out;
}

// The first Spotify.exe present. fs.access, not stat: the Store's execution
// alias is a reparse point that stat refuses (EACCES) but access sees.
async function findWindowsExe(env, accessFn = fs.promises.access) {
  for (const p of windowsExeCandidates(env)) {
    try { await accessFn(p); return p; } catch { /* not this one */ }
  }
  return '';
}

// Pure: what to run, given the Spotify.exe found (Windows only, '' for none).
// `direct` means the command IS Spotify (success = it started); otherwise it is
// an opener whose exit code says whether it worked.
function launchPlan(platform, minimized, winExe) {
  const wantMin = minimized === true;
  if (platform === 'win32') {
    const exe = winExe || '';
    if (exe) return { cmd: exe, args: wantMin ? ['--minimized'] : [], direct: true, minimized: wantMin };
    return { cmd: 'powershell.exe', args: WIN_PROTOCOL_ARGS, direct: false, minimized: false };
  }
  if (platform === 'darwin') {
    return { cmd: '/usr/bin/open', args: wantMin ? ['-g', '-j', '-a', 'Spotify'] : ['-a', 'Spotify'], direct: false, minimized: wantMin };
  }
  return { cmd: 'xdg-open', args: ['spotify:'], direct: false, minimized: false };
}

function canStartMinimizedOn(platform, winExe) {
  return platform === 'win32' ? !!winExe : platform === 'darwin';
}

// Run a plan detached. Resolves { ok, minimized } or { ok: false, error }; never
// rejects. An 'error' event (ENOENT: no xdg-open, no Spotify) is a failure that
// must be listened for, or it would take the server down.
function runPlan(plan, spawnFn = spawn, settleMs = LAUNCH_SETTLE_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      // windowsHide only for the PowerShell opener: on Spotify itself it would
      // ask Windows to start the app's window hidden.
      child = spawnFn(plan.cmd, plan.args, { detached: true, stdio: 'ignore', windowsHide: !plan.direct });
    } catch {
      resolve({ ok: false, error: 'launch_failed' });
      return;
    }
    let done = false;
    let timer = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.unref(); } catch { /* already gone */ }
      resolve(r);
    };
    const started = { ok: true, minimized: plan.minimized };
    child.on('error', () => finish({ ok: false, error: 'launch_failed' }));
    if (plan.direct) {
      child.once('spawn', () => finish(started));
      return;
    }
    child.once('exit', (code) => finish(code === 0 ? started : { ok: false, error: 'launch_failed' }));
    timer = setTimeout(() => finish(started), settleMs);
  });
}

const winExeHere = () => (process.platform === 'win32' ? findWindowsExe(process.env) : Promise.resolve(''));

async function launchSpotify(opts) {
  const minimized = !!(opts && opts.minimized === true);
  return runPlan(launchPlan(process.platform, minimized, await winExeHere()));
}

async function canStartMinimized() {
  return canStartMinimizedOn(process.platform, await winExeHere());
}

module.exports = {
  launchSpotify, canStartMinimized,
  // The parts below take their inputs, for the tests.
  launchPlan, runPlan, findWindowsExe, canStartMinimizedOn,
};
