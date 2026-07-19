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

function runElevated(file, args = [], { timeoutMs = 600000 } = {}) {
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

module.exports = { run, runElevated, UAC_CANCELLED };
