// Finds where OBS is installed and starts it, for an OBS action pressed while OBS is closed.

const { execFile, spawn } = require('node:child_process');
const path = require('node:path');

// ── OBS auto-launch: open OBS when an OBS action is clicked while it's closed,
// then run the action once it connects. ──────────────────────────────────────
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read OBS's install dir from the registry (HKLM\SOFTWARE\OBS Studio default).
// Returns the path string or null; never throws.
function readObsInstallDir() {
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-Command', "$ErrorActionPreference='SilentlyContinue'; (Get-ItemProperty 'HKLM:\\SOFTWARE\\OBS Studio').'(default)'"],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const dir = String(stdout || '').trim();
        resolve(dir || null);
      });
  });
}

// Launch obs64.exe with its required working directory (bin\64bit). Best-effort.
function launchObs(exe) {
  try { spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false }).unref(); }
  catch (e) { console.error('OBS launch failed:', e.message); }
}

module.exports = { _sleep, readObsInstallDir, launchObs };
