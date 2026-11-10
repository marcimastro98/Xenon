'use strict';

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const nodePath = require('node:path');
const { psEscape, psQuote } = require('../ps-quote');

/**
 * Start something and deliberately do NOT wait for it.
 *
 * `run` is the wrong tool for a program that is meant to stay up: it waits, and
 * at its timeout it KILLS the child — so using it to launch a tray application
 * would start the thing and then shoot it a few seconds later. This resolves as
 * soon as the process exists, and leaves it running past our own lifetime.
 *
 * `ok` therefore means "it started", never "it worked". The caller checks the
 * world afterwards, which is the only thing that can answer the second question.
 *
 * A deliberate exception to "stop what you start": what this launches is the
 * USER's application, not a child of ours. It was theirs to run before Xenon
 * existed and must outlive the dashboard, so it is `unref`'d and never entered
 * into `_gracefulShutdown` — killing it on our way out would take the user's
 * network down because a widget host restarted. Do not use this for anything we
 * own; those still belong in the shutdown path.
 */
function spawnDetached(file, args = []) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const child = spawn(String(file), args.map(String), {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      // Exactly one of these fires, so the promise settles once either way.
      child.once('spawn', () => { child.unref(); done({ ok: true }); });
      child.once('error', (e) => done({ ok: false, error: String((e && e.message) || e) }));
    } catch (e) {
      done({ ok: false, error: String((e && e.message) || e) });
    }
  });
}

/**
 * Esegue un comando e risolve con { code, stdout, stderr, timedOut }.
 * Non rigetta su exit code != 0: il chiamante decide come interpretarlo.
 * timeoutMs protegge da processi bloccati.
 */
function run(file, args = [], { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        timedOut: !!(err && (err.killed || err.code === 'ETIMEDOUT')),
      });
    });
  });
}

/**
 * Esegue un comando con elevazione UAC tramite PowerShell Start-Process -Verb RunAs.
 * NON cattura stdout (il processo elevato e separato); risolve quando termina.
 *
 * `code` e' l'exit code del processo ELEVATO, non quello di PowerShell: senza
 * -PassThru l'host esce sempre 0 e un comando fallito (es. `devcon install` che
 * non crea nulla) veniva riportato come successo. UAC annullato -> 1223
 * (ERROR_CANCELLED), cosi il chiamante distingue "l'utente ha detto no" da "il
 * comando e' fallito".
 */
const UAC_CANCELLED = 1223;

// pkexec's own exit codes, which are NOT the command's: 126 is "the dialog was
// dismissed or the user is not authorised", 127 is "could not run it at all".
// 126 is the exact analogue of a declined UAC prompt, so it is reported as
// UAC_CANCELLED and every caller's "the user said no" branch keeps working
// unchanged on three platforms. (Only the WORD is Windows': the panel looks the
// message up per platform so nobody on Linux is told about UAC.)
const PKEXEC_DISMISSED = 126;
const PKEXEC_FAILED = 127;

/**
 * The POSIX half of runElevated. pkexec is the honest counterpart of UAC: a
 * graphical password prompt owned by the desktop, not a sudo call from a
 * dashboard. It needs a polkit agent (every mainstream desktop runs one) and,
 * crucially, the graphical environment variables — a backend started by systemd
 * --user without WAYLAND_DISPLAY/DISPLAY in its environment gets a prompt that
 * cannot be drawn, which surfaces as a silent refusal.
 */
function runElevatedPosix(file, args, timeoutMs) {
  // pkexec itself by absolute path: it is setuid root and lives in a system
  // directory, so there is no reason to let $PATH pick which one runs.
  const pkexec = findSystemBinary('pkexec') || 'pkexec';
  return run(pkexec, [String(file), ...args.map(String)], { timeoutMs })
    .then(mapPkexecResult);
}

// ── What root may run ───────────────────────────────────────────────────────
// Elevating a binary hands root whatever is at that path WHEN pkexec/osascript
// gets to it. If the file, or any directory above it, is writable by the
// (unprivileged) user, then any program running as that user can swap the
// binary between our check and the password prompt and have root execute its
// own code — a clean local privilege escalation that the user's password
// "approves". Homebrew is the common case: /opt/homebrew/bin/tailscale and
// /home/linuxbrew/... are owned by the user. So on macOS/Linux we only elevate
// a file whose every path component (following symlinks, each hop checked) is
// owned by root and not writable by group or others.
//
// A bare command name is resolved here against fixed system directories only,
// never $PATH: a user-controlled ~/.local/bin earlier in PATH would otherwise
// decide what `sh` or `systemctl` means for root.
const SYSTEM_BIN_DIRS = ['/usr/sbin', '/usr/bin', '/sbin', '/bin', '/usr/local/sbin', '/usr/local/bin'];

function findSystemBinary(name, fsx = fs) {
  for (const dir of SYSTEM_BIN_DIRS) {
    const cand = nodePath.posix.join(dir, name);
    try {
      if (fsx.statSync(cand).isFile()) return cand;
    } catch { /* not here */ }
  }
  return '';
}

// Returns null when every component is trustworthy, else a human-readable reason.
function untrustedPathReason(p, fsx, depth = 0) {
  if (depth > 16) return `${p}: too many symbolic links`;
  const parts = nodePath.posix.normalize(p).split('/').filter(Boolean);
  let cur = '/';
  for (let i = 0; i <= parts.length; i++) {
    if (i > 0) cur = nodePath.posix.join(cur, parts[i - 1]);
    let st;
    try { st = fsx.lstatSync(cur); } catch { return `${cur} does not exist`; }
    if (st.uid !== 0) return `${cur} is not owned by root`;
    if (st.isSymbolicLink()) {
      // The link itself sits in a directory we already checked; now check
      // where it leads, with the rest of the path appended.
      let target;
      try { target = fsx.readlinkSync(cur); } catch { return `${cur} cannot be read`; }
      const next = nodePath.posix.join(nodePath.posix.resolve(nodePath.posix.dirname(cur), target), ...parts.slice(i));
      return untrustedPathReason(next, fsx, depth + 1);
    }
    if (st.mode & 0o022) return `${cur} is writable by group or others`;
    if (i === parts.length && !st.isFile()) return `${cur} is not a regular file`;
  }
  return null;
}

/**
 * Decide whether `file` may be run as root. Resolves a bare name against the
 * system directories. Returns { ok: true, path } or { ok: false, error }.
 * `fsx` is injectable so tests can describe a filesystem without needing root.
 */
function checkElevatable(file, fsx = fs) {
  const f = String(file || '');
  if (!f) return { ok: false, error: 'no binary given' };
  const abs = nodePath.posix.isAbsolute(f) ? f
    : (f.includes('/') ? '' : findSystemBinary(f, fsx));
  if (!abs) return { ok: false, error: `${f} was not found in a system directory` };
  const why = untrustedPathReason(abs, fsx);
  if (why) return { ok: false, error: why };
  // Belt and braces: the kernel's own resolution must land somewhere that
  // passes too (covers `..` after a symlink, which the lexical join above
  // cannot model exactly).
  let real = abs;
  try { real = fsx.realpathSync(abs); } catch { return { ok: false, error: `${abs} cannot be resolved` }; }
  if (real !== abs) {
    const why2 = untrustedPathReason(real, fsx);
    if (why2) return { ok: false, error: why2 };
  }
  return { ok: true, path: abs };
}

// The shape every caller already understands: a non-zero code with stderr is
// reported as "failed" with that text; it is NOT UAC_CANCELLED, so nobody is
// told the user said no.
const UNTRUSTED_BINARY_CODE = 126;
function refusedElevation(file, error) {
  return {
    code: UNTRUSTED_BINARY_CODE,
    stdout: '',
    stderr: `untrusted_binary: refusing to run ${file} as administrator (${error}). `
      + 'Install it from the vendor package so it is owned by root, or run the step yourself.',
    timedOut: false,
    refused: 'untrusted_binary',
  };
}

/** Pure, and exported, so the mapping can be stated without spawning pkexec. */
function mapPkexecResult(r) {
  if (r.code === PKEXEC_DISMISSED) return { ...r, code: UAC_CANCELLED };
  if (r.code === PKEXEC_FAILED && !r.stdout) {
    return { ...r, stderr: r.stderr || 'pkexec could not run the command' };
  }
  return r;
}

// macOS has no pkexec. Its equivalent is AppleScript's `with administrator
// privileges`, which raises the same system dialog (and Touch ID where the Mac
// has it). Cancelling it is AppleScript error -128.
const OSA_CANCELLED_RE = /-128|User canceled/i;

/** Escape for embedding inside an AppleScript double-quoted string literal. */
function osaQuote(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function runElevatedMac(file, args, timeoutMs) {
  // Each word is quoted for the shell that AppleScript will spawn, then the
  // whole thing is quoted again for AppleScript. Nothing here comes from a
  // request, but the two layers are easy to get wrong and worth being explicit
  // about.
  const shellCmd = [file, ...args]
    .map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`)
    .join(' ');
  const script = `do shell script "${osaQuote(shellCmd)}" with administrator privileges`;
  return run('/usr/bin/osascript', ['-e', script], { timeoutMs }).then(mapOsascriptResult);
}

/** Pure, and exported, so the mapping can be stated without opening a dialog. */
function mapOsascriptResult(r) {
  if (r.code !== 0 && OSA_CANCELLED_RE.test(r.stderr || '')) {
    return { ...r, code: UAC_CANCELLED };
  }
  return r;
}

function runElevated(file, args = [], { timeoutMs = 600000, fsx = fs } = {}) {
  if (process.platform !== 'win32') {
    const trust = checkElevatable(file, fsx);
    if (!trust.ok) return Promise.resolve(refusedElevation(String(file), trust.error));
    if (process.platform === 'darwin') return runElevatedMac(trust.path, args, timeoutMs);
    return runElevatedPosix(trust.path, args, timeoutMs);
  }
  const safeFile = psEscape(file);
  const argList = args.map((a) => psQuote(a)).join(',');
  const start = argList
    ? `Start-Process -FilePath '${safeFile}' -ArgumentList ${argList} -Verb RunAs -Wait -PassThru`
    : `Start-Process -FilePath '${safeFile}' -Verb RunAs -Wait -PassThru`;
  // ExitCode resta $null se il processo e' gia' uscito quando -PassThru lo
  // restituisce: trattarlo come fallimento eviterebbe di rompere i chiamati che
  // riescono, quindi in quel caso ricadiamo sul vecchio comportamento (0).
  const ps = [
    '$ErrorActionPreference = \'Stop\'',
    `try { $p = ${start} } catch { exit ${UAC_CANCELLED} }`,
    'if ($null -eq $p) { exit 1 }',
    'if ($null -eq $p.ExitCode) { exit 0 }',
    'exit $p.ExitCode',
  ].join('; ');
  return run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs });
}

module.exports = {
  run, runElevated, spawnDetached, mapPkexecResult, mapOsascriptResult, osaQuote,
  checkElevatable, findSystemBinary, UAC_CANCELLED, PKEXEC_DISMISSED,
};
