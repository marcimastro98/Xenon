'use strict';

const { execFile } = require('node:child_process');

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
  return run('pkexec', [String(file), ...args.map(String)], { timeoutMs })
    .then(mapPkexecResult);
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
  return run('osascript', ['-e', script], { timeoutMs }).then(mapOsascriptResult);
}

/** Pure, and exported, so the mapping can be stated without opening a dialog. */
function mapOsascriptResult(r) {
  if (r.code !== 0 && OSA_CANCELLED_RE.test(r.stderr || '')) {
    return { ...r, code: UAC_CANCELLED };
  }
  return r;
}

function runElevated(file, args = [], { timeoutMs = 600000 } = {}) {
  if (process.platform === 'darwin') return runElevatedMac(file, args, timeoutMs);
  if (process.platform !== 'win32') return runElevatedPosix(file, args, timeoutMs);
  const safeFile = String(file).replace(/'/g, "''");
  const argList = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',');
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
  run, runElevated, mapPkexecResult, mapOsascriptResult, osaQuote,
  UAC_CANCELLED, PKEXEC_DISMISSED,
};
