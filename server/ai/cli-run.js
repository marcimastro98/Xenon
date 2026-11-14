'use strict';
// Runs the Claude Code or Codex program once for the assistant: a clean environment, a time
// limit, capped output, and a second try without a flag an older version does not know.

const { spawn } = require('node:child_process');
const { TIMEOUT_MS, MAX_STDOUT, MAX_STDERR } = require('./cli-limits.js');

// The child sees the user's environment minus anything that would switch it
// from the subscription to per-token billing.
const STRIP_ENV = Object.freeze({
  claudecode: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
});
function childEnv(provider) {
  const env = Object.assign({}, process.env);
  for (const k of STRIP_ENV[provider] || []) delete env[k];
  return env;
}

// `abortOn`: a pattern in the output that means waiting longer is pointless.
// Codex, offline, retries "waiting for network" for as long as it is let.
// `signal`: an AbortSignal; the user pressed Cancel, so the child is killed and
// the result says `cancelled` rather than looking like a failure.
function run(exe, args, { input = '', timeoutMs = TIMEOUT_MS, env, cwd, abortOn = null, signal = null } = {}) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) { resolve({ code: -1, stdout: '', stderr: '', timedOut: false, aborted: false, cancelled: true }); return; }
    let child;
    try {
      child = spawn(exe.cmd, exe.pre.concat(args), { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String((e && e.message) || e), timedOut: false });
      return;
    }
    let stdout = '', stderr = '', timedOut = false, aborted = false, cancelled = false, done = false;
    const onAbort = () => { cancelled = true; try { child.kill(); } catch { /* gone */ } };
    const finish = (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted, cancelled });
    };
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => {
      if (stdout.length < MAX_STDOUT) stdout += d;
      if (abortOn && !aborted && abortOn.test(String(d))) { aborted = true; try { child.kill(); } catch { /* gone */ } }
    });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_STDERR) stderr += d; });
    child.on('error', (e) => { stderr += String((e && e.message) || e); finish(-1); });
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => { /* child exited before reading: reported via close */ });
    child.stdin.end(input);
  });
}

// Flags a program version may not know yet. When it says so, the flag is
// dropped and the call tried again, rather than the whole provider failing on
// a program one release older than this code. Only flags that are about tidiness
// are optional; the ones that keep tools off are not.
const UNKNOWN_FLAG_RE = /(?:unknown option|unexpected argument)\s+'(--[a-z0-9-]+)/i;
async function runWithOptional(exe, build, optional, opts) {
  const skip = new Set();
  for (let i = 0; i <= optional.length; i++) {
    const r = await run(exe, build(skip), opts);
    const m = r.code !== 0 && UNKNOWN_FLAG_RE.exec(r.stderr);
    if (m && optional.includes(m[1]) && !skip.has(m[1])) { skip.add(m[1]); continue; }
    return r;
  }
  return run(exe, build(skip), opts);
}

module.exports = { STRIP_ENV, childEnv, run, UNKNOWN_FLAG_RE, runWithOptional };
