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
 * Il chiamante verifica l'esito ricontrollando lo stato (es. presenza del tool).
 */
function runElevated(file, args = [], { timeoutMs = 600000 } = {}) {
  const safeFile = String(file).replace(/'/g, "''");
  const argList = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',');
  const ps = argList
    ? `Start-Process -FilePath '${safeFile}' -ArgumentList ${argList} -Verb RunAs -Wait`
    : `Start-Process -FilePath '${safeFile}' -Verb RunAs -Wait`;
  return run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs });
}

module.exports = { run, runElevated };
