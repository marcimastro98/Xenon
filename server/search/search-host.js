'use strict';
// The process that asks Windows Search: started when a query needs it, taken out of service
// when its pipe breaks or it has been idle, and its waiting request refused when it goes.

const { spawn } = require('node:child_process');
const { HOST_IDLE_MS, HOST_RETRY_MS } = require('./search-limits.js');

function makeHost({ CATALOG_SUPPORTED, scriptPath, host }) {
  function rejectPending(id, err) {
    const p = host.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    host.pending.delete(id);
    p.reject(err);
  }

  function retireHost(reason) {
    const proc = host.proc;
    host.proc = null;
    host.buf = '';
    if (reason !== 'idle') host.diedAt = Date.now();
    if (host.idleTimer) { clearTimeout(host.idleTimer); host.idleTimer = null; }
    for (const id of [...host.pending.keys()]) rejectPending(id, new Error(reason || 'search host down'));
    if (!proc) return;
    // stdin close ends the serve loop → clean exit releases the COM connection.
    try { proc.stdin.end(); } catch {}
    const force = setTimeout(() => { try { proc.kill(); } catch {} }, 3000);
    force.unref();
    proc.once('exit', () => clearTimeout(force));
  }

  function bumpIdle() {
    if (host.idleTimer) clearTimeout(host.idleTimer);
    host.idleTimer = setTimeout(() => retireHost('idle'), HOST_IDLE_MS);
    host.idleTimer.unref();
  }

  function ensureHost() {
    // The catalog host is powershell.exe running search.ps1 against the Windows
    // SystemIndex. Off Windows there is nothing to spawn, and trying produced an
    // ENOENT the caller reported as `error` — indistinguishable from a catalog
    // that broke, which is why the Spotlight popup told a Mac user that
    // "Windows Search is turned off on this PC". `unsupported` is a different
    // fact from `unavailable` and the UI is entitled to say so.
    if (!CATALOG_SUPPORTED) return null;
    if (host.proc) return host.proc;
    if (Date.now() - host.diedAt < HOST_RETRY_MS) return null;
    let proc;
    try {
      proc = spawn('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Serve'],
        { windowsHide: true });
    } catch { return null; }
    host.proc = proc;
    host.buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      host.buf += chunk;
      let nl;
      while ((nl = host.buf.indexOf('\n')) !== -1) {
        const line = host.buf.slice(0, nl).trim();
        host.buf = host.buf.slice(nl + 1);
        if (!line.startsWith('XESRCH ')) continue;
        let env;
        try { env = JSON.parse(Buffer.from(line.slice(7), 'base64').toString('utf8')); }
        catch { continue; }
        const p = host.pending.get(env.id);
        if (!p) continue;
        clearTimeout(p.timer);
        host.pending.delete(env.id);
        if (env.ok) p.resolve(Array.isArray(env.out) ? env.out : []);
        else p.reject(new Error(env.err || 'search host error'));
      }
    });
    proc.stderr.on('data', () => {});
    // A write to a pipe whose child is already gone reports EPIPE/ECONNRESET
    // ASYNCHRONOUSLY, as an 'error' event on the stream — the try/catch around
    // stdin.write() never sees it, and an unhandled 'error' on a stream takes
    // the whole server down. Route it to the same retire path the exit handler
    // uses: the host is dead either way, and every caller already falls back.
    proc.stdin.on('error', () => { if (host.proc === proc) retireHost('search host pipe error'); });
    proc.on('error', () => { if (host.proc === proc) retireHost('search host spawn error'); });
    proc.on('exit', () => { if (host.proc === proc) retireHost('search host exited'); });
    proc.unref();
    return proc;
  }

  return { rejectPending, retireHost, bumpIdle, ensureHost };
}

module.exports = { makeHost };
