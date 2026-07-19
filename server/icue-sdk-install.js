'use strict';

// ── In-app fetch for the CORSAIR iCUE SDK client component ───────────────────
// The installer sets the component up (install.ps1 -> Install-ICueSdkIfNeeded),
// but an existing install never re-runs the installer: a user who self-updates
// into a version that needs the component would otherwise be stuck with no
// CORSAIR RGB and no way to fix it from the app. This is that way — the button
// on Settings -> Illuminazione when the SDK is missing.
//
// The download, the pinned version + SHA-256 and the licence rationale all live
// in icue-sdk-update.ps1, the single source of truth shared with the installer
// (same arrangement as helper-update.ps1). This module only runs it and reports
// what happened; it holds no version and no URL of its own.

const path = require('path');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, 'icue-sdk-update.ps1');
const SDK_DIR = path.join(__dirname, 'icue-sdk');
const PS_EXE = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const TIMEOUT_MS = 180000; // the archive is ~340 KB, but a slow link plus extraction needs room

let inFlight = null; // one fetch at a time — repeated taps must not spawn a second download

// Runs the shared script and resolves { ok, status, detail }. Never throws and
// never rejects: a failed fetch is a message for the user, not a 500.
function install() {
  if (inFlight) return inFlight;
  inFlight = new Promise((resolve) => {
    let child;
    try {
      // argv array + -File, so nothing is parsed as a shell command.
      child = spawn(PS_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-SdkDir', SDK_DIR, '-Quiet'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ ok: false, status: 'error', detail: e.message });
    }

    let out = '';
    let errOut = '';
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      done({ ok: false, status: 'error', detail: 'the download timed out' });
    }, TIMEOUT_MS);

    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { errOut += b.toString(); });
    child.on('error', (e) => done({ ok: false, status: 'error', detail: e.message }));
    child.on('close', () => {
      // The script's last line is "<status>\t<detail>".
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      const tab = line.indexOf('\t');
      const status = tab > 0 ? line.slice(0, tab) : '';
      const detail = tab > 0 ? line.slice(tab + 1) : (line || errOut.trim());
      if (status === 'ok' || status === 'present') return done({ ok: true, status, detail });
      done({ ok: false, status: 'error', detail: detail || 'the component could not be installed' });
    });
  }).finally(() => { inFlight = null; });
  return inFlight;
}

function isInstalling() { return !!inFlight; }

module.exports = { install, isInstalling, SDK_DIR };
