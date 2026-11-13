// The one PowerShell process that stays open to run the read-only scripts: starts it, sends it
// a script, and falls back to a fresh process when it fails.

const { spawn } = require('node:child_process');
const path = require('node:path');
const { POWERSHELL_SUPPORTED } = require('../powershell/supported.js');
const { parseJsonOutput } = require('../powershell/read-json.js');
const { PWSH_WORKER_GC_BUDGET } = require('./pwsh-worker-memory.js');
const { lowerPriority } = require('../child-priority.js');
const { runPowerShellScript } = require('../powershell/run-command.js');
const { PWSH_WORKER_SCRIPT } = require('./script-paths.js');
const { _worker, _workerReject, _killWorker } = require('../powershell/worker-state.js');

function _ensureWorker() {
  if (!POWERSHELL_SUPPORTED) return null;
  if (_worker.proc) return _worker.proc;
  let proc;
  try {
    proc = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PWSH_WORKER_SCRIPT],
      { windowsHide: true, env: { ...process.env, COMPlus_GCgen0MaxBudget: PWSH_WORKER_GC_BUDGET } });
  } catch { return null; }
  lowerPriority(proc.pid);
  _worker.proc = proc;
  _worker.buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => {
    _worker.buf += chunk;
    let nl;
    while ((nl = _worker.buf.indexOf('\n')) !== -1) {
      const line = _worker.buf.slice(0, nl).trim();
      _worker.buf = _worker.buf.slice(nl + 1);
      if (!line.startsWith('XEHWK ')) continue; // ignore any stray output
      let env;
      try { env = JSON.parse(Buffer.from(line.slice(6), 'base64').toString('utf8')); }
      catch { continue; }
      const p = _worker.pending.get(env.id);
      if (!p) continue;
      clearTimeout(p.timer);
      _worker.pending.delete(env.id);
      if (env.ok) p.resolve(env.out || '');
      else p.reject(new Error(env.err || 'worker error'));
    }
  });
  proc.stderr.on('data', () => {}); // collectors trap their own errors; ignore
  // A write to a pipe whose child is already gone reports EPIPE/ECONNRESET
  // ASYNCHRONOUSLY, as an 'error' event on the stream — the try/catch around
  // stdin.write() never sees it, and an unhandled 'error' on a stream takes the
  // whole server down. Route it to the same retire path the exit handler uses:
  // the host is dead either way, and every caller already falls back.
  proc.stdin.on('error', () => _killWorker('worker pipe error'));
  proc.on('error', () => _killWorker('worker spawn error'));
  proc.on('exit', () => { if (_worker.proc === proc) _killWorker('worker exited'); });
  proc.unref(); // never keep the event loop alive on the worker's account
  return proc;
}

function runPowerShellWorker(scriptPath, args = [], timeout = 8000) {
  return new Promise((resolve, reject) => {
    const proc = _ensureWorker();
    if (!proc) { reject(new Error('worker unavailable')); return; }
    const id = _worker.nextId++;
    const timer = setTimeout(() => {
      // The worker processes requests serially; a timeout means it is wedged on
      // this one. Reject and kill so the next call gets a fresh host — safe here
      // because these collectors hold no SMTC/WinRT handles (OS reclaims theirs
      // on process death).
      _workerReject(id, new Error('worker timeout'));
      _killWorker('worker timeout');
    }, timeout);
    _worker.pending.set(id, { resolve, reject, timer });
    try {
      proc.stdin.write(JSON.stringify({ id, script: path.basename(scriptPath), args }) + '\n');
    } catch (e) {
      clearTimeout(timer);
      _worker.pending.delete(id);
      reject(e);
    }
  });
}

// Run a read-only collector through the persistent worker, falling back to a
// one-shot spawn on any worker problem. Returns the same parsed-JSON object as
// runPowerShellScript, so call sites are unchanged.
async function runCollector(scriptPath, args = [], timeout = 8000) {
  try {
    return parseJsonOutput(await runPowerShellWorker(scriptPath, args, timeout));
  } catch {
    return runPowerShellScript(scriptPath, args, timeout);
  }
}

module.exports = { _ensureWorker, runPowerShellWorker, runCollector };
