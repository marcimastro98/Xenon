// Runs the helper program once for one answer and gives back what it printed as JSON.

const { spawn } = require('node:child_process');
const { parseJsonOutput } = require('../powershell/read-json.js');
const { HELPER_EXE } = require('../engine/paths.js');

// One-shot run of the native helper (e.g. `xenon-helper windows list`). Unlike
// the persistent media/foreground hosts this spawns per request — the trimmed
// native exe starts in tens of ms, versus ~1s of PowerShell engine start plus
// an Add-Type C# compile for windows.ps1 — which is what makes the Apps panel
// open near-instantly. Resolves the parsed JSON from stdout, rejects on any
// problem so the caller can fall back to the PowerShell path.
function runHelperOneShot(args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(HELPER_EXE, args, { windowsHide: true }); }
    catch (e) { reject(e); return; }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => {
      try { if (!child.killed) child.kill(); } catch { }
      finish(reject, new Error('helper timeout'));
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', e => finish(reject, e));
    child.on('close', code => {
      if (code !== 0) { finish(reject, new Error(stderr || `helper exited with ${code}`)); return; }
      try { finish(resolve, parseJsonOutput(stdout)); }
      catch (e) { finish(reject, e); }
    });
  });
}

module.exports = { runHelperOneShot };
