#!/usr/bin/env node
// `npm run dev` — free the dev port, then start the server.
// `npm run native:dev` (--native) — stop a stale native shell, then start it.
//
// Both were PowerShell one-liners, which meant the two commands a developer
// runs most could not be run at all on the machines this port exists to
// support. Same behaviour, three platforms.
//
// Clearing the stale process first matters because a half-dead server from the
// previous run holds :3030 and the new one exits with EADDRINUSE, which reads
// as "the app is broken" rather than "the old one is still there".

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.XENON_PORT) || 3030;

// Returns the PIDs listening on `port`, never this process. Each platform's
// answer comes from whichever tool is always present: no lsof on a bare Fedora,
// no ss on a Mac.
function listenerPids() {
  const out = new Set();
  const add = (v) => {
    const n = Number(String(v).trim());
    if (Number.isInteger(n) && n > 0 && n !== process.pid) out.add(n);
  };

  if (process.platform === 'win32') {
    // -NoProfile: a developer's profile can print banners that poison stdout.
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -EA SilentlyContinue).OwningProcess`],
      { encoding: 'utf8' });
    (r.stdout || '').split(/\r?\n/).forEach(add);
    return out;
  }

  // lsof is on every Mac and most Linuxes; ss covers the systemd distros that
  // ship without it. Trying both and unioning is cheaper than detecting.
  const lsof = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  (lsof.stdout || '').split(/\r?\n/).forEach(add);

  const ss = spawnSync('ss', ['-lptnH', `sport = :${port}`], { encoding: 'utf8' });
  for (const m of (ss.stdout || '').matchAll(/pid=(\d+)/g)) add(m[1]);

  return out;
}

function freePort() {
  const pids = listenerPids();
  if (!pids.size) return;
  for (const pid of pids) {
    try {
      process.kill(pid, process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL');
      console.log(`[dev] freed port ${port} (pid ${pid})`);
    } catch { /* already gone, or not ours to kill — the server will say so */ }
  }
  // The socket does not close on the same tick the process dies.
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},600)']);
}

// The Tauri shell is killed by name, not by port — it holds no socket. A
// leftover one keeps a lock on the build output and the rebuild fails.
function killNativeShell() {
  const r = process.platform === 'win32'
    ? spawnSync('taskkill', ['/IM', 'xenon-native.exe', '/F'], { encoding: 'utf8' })
    : spawnSync('pkill', ['-x', 'xenon-native'], { encoding: 'utf8' });
  // Exit 1 from pkill / 128 from taskkill both mean "nothing matched", which is
  // the normal case and not worth printing.
  if (r.status === 0) console.log('[dev] stopped a running xenon-native');
}

const native = process.argv.includes('--native');

if (native) {
  killNativeShell();
  // npm is a shell script on POSIX and a .cmd on Windows; `shell: true` lets
  // both resolve without hardcoding either name.
  const child = spawn('npm', ['run', 'dev', '--workspace', '@xenon/native'], {
    stdio: 'inherit', cwd: root, shell: true,
  });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
} else {
  freePort();
  const child = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
    stdio: 'inherit', cwd: root,
  });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
}
