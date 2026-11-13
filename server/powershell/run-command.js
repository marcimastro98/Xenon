// Runs one PowerShell command or script file as its own process, with UTF-8 output and a time
// limit; refuses on a system without PowerShell.

const { execFile, spawn } = require('node:child_process');
const path = require('node:path');
const { POWERSHELL_SUPPORTED } = require('./supported.js');
const { parseJsonOutput } = require('./read-json.js');

function powerShellUtf8Command(command) {
  return `$utf8NoBom = New-Object System.Text.UTF8Encoding $false; [Console]::OutputEncoding = $utf8NoBom; $OutputEncoding = $utf8NoBom; ${command}`;
}

function runPowerShellScript(script, args = [], timeout = 5000) {
  if (!POWERSHELL_SUPPORTED) return Promise.reject(new Error('unsupported_platform'));
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let resolvedEarly = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    // Resolve the promise as soon as we have valid JSON, but DO NOT kill the
    // PowerShell process — let it exit on its own so WinRT/COM handles (SMTC
    // session, thumbnail stream, DataReader, …) get released cleanly. Killing
    // mid-flight is what leaks broker handles and eventually wedges Windows
    // shutdown.
    const finishOk = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const finishErr = err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed && child.exitCode === null) child.kill();
      reject(err);
    };

    const resolveIfJsonReady = () => {
      if (resolvedEarly) return;
      if (!stdout.trimEnd().endsWith('}')) return;
      try {
        const value = parseJsonOutput(stdout);
        resolvedEarly = true;
        finishOk(value);
      } catch { }
    };

    const timer = setTimeout(() => {
      try { finishOk(parseJsonOutput(stdout)); }
      catch { finishErr(new Error(stderr || `PowerShell timeout: ${path.basename(script)}`)); }
    }, timeout);

    child.stdout.on('data', chunk => { stdout += chunk; resolveIfJsonReady(); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', e => finishErr(e));
    child.on('close', code => {
      if (settled) return;
      try { finishOk(parseJsonOutput(stdout)); }
      catch (e) { finishErr(new Error(stderr || e.message || `PowerShell exited with ${code}`)); }
    });
  });
}

function runPowerShellCommand(command, timeout = 5000) {
  if (!POWERSHELL_SUPPORTED) return Promise.reject(new Error('unsupported_platform'));
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', powerShellUtf8Command(command)], {
      timeout,
      windowsHide: true,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr || err.message)); return; }
      try { resolve(parseJsonOutput(stdout)); }
      catch (e) { reject(e); }
    });
  });
}

module.exports = { powerShellUtf8Command, runPowerShellScript, runPowerShellCommand };
