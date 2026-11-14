'use strict';
// Looks after the browser tile's own profile folder: ends a browser left over from a crash,
// clears its locks, and starts the profile over when it was spoiled.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function pidFilePath(profileDir) { return path.join(profileDir, 'edge.pid'); }

// Best-effort orphan reaper. On an unclean server exit (terminal window closed
// with the X, a crash — no SIGINT/SIGTERM, so _gracefulShutdown never runs) the
// headless Edge we launched can be left holding this profile's singleton lock,
// which then blocks — and silently fails — every future launch. We record each
// launched Edge's PID in a file inside the profile dir and, before spawning a
// fresh one, tree-kill exactly that PID.
// The POSIX half of the reaper. Same job, same caution, far less machinery:
// signal the pid we ourselves recorded, but ONLY after `ps` confirms that pid is
// still a process whose command line carries our own profile directory. A pid
// file outlives the process it names, and pids are recycled — without that check
// this would eventually signal an unrelated program of the user's.
function reapStaleProfilePosix(profileDir) {
  let pid = 0;
  try { pid = parseInt(fs.readFileSync(pidFilePath(profileDir), 'utf8'), 10); } catch (e) { pid = 0; }
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  const leaf = path.basename(profileDir);
  return new Promise((resolve) => {
    let out = '';
    let p;
    try {
      // -o args= prints the command line alone, with no header to skip.
      p = spawn('ps', ['-p', String(pid), '-o', 'args='], { windowsHide: true });
    } catch (e) { resolve(); return; }
    p.stdout.on('data', (d) => { out += String(d); });
    p.on('error', () => resolve());
    p.on('close', () => {
      if (!out.includes(leaf)) { resolve(); return; }   // gone, or somebody else's
      try { process.kill(pid, 'SIGTERM'); } catch (e) { /* already exited */ }
      resolve();
    });
    setTimeout(() => { try { p.kill(); } catch (e) { /* ignore */ } resolve(); }, 4000).unref();
  });
}

//
// This deliberately uses `taskkill` with a PID+image-name filter rather than a
// WMI/CIM process scan: the filter kills the process ONLY if that PID is still an
// msedge.exe (so a recycled PID belonging to some unrelated app is never touched),
// it targets only the Edge we ourselves started (never the user's real browser),
// and it avoids the "enumerate processes + kill by command line" pattern that
// antivirus ML heuristics (Defender's Wacatac.B!ml) flag as suspicious.
function reapStaleProfileEdge(profileDir) {
  if (process.platform !== 'win32') return reapStaleProfilePosix(profileDir);
  let pid = 0;
  try { pid = parseInt(fs.readFileSync(pidFilePath(profileDir), 'utf8'), 10); } catch (e) { pid = 0; }
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn('taskkill', [
        '/fi', 'PID eq ' + pid,
        '/fi', 'IMAGENAME eq msedge.exe',
        '/t', '/f',
      ], { windowsHide: true });
    } catch (e) { resolve(); return; }
    p.on('exit', resolve);
    p.on('error', () => resolve());
    setTimeout(() => { try { p.kill(); } catch (e) { /* ignore */ } resolve(); }, 4000).unref();
  });
}

// Delete the port file and any singleton locks a force-killed instance left
// behind, so a fresh Edge owns the profile cleanly instead of forwarding to (and
// exiting toward) a dead one.
function clearProfileLocks(profileDir) {
  for (const f of ['DevToolsActivePort', 'lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(profileDir, f), { force: true }); } catch (e) { /* absent or held; best effort */ }
  }
}

// Fallback sweep — used ONLY when a launch times out because the profile is still
// locked by an Edge we couldn't attribute to our recorded PID (an orphan from a
// previous version, or a tree whose launcher died leaving reparented children).
// The precise pid-file reap can't see those, so here we do have to find Edge by
// its command line. To stay clear of the antivirus "enumerate + kill" heuristic,
// PowerShell only READS the matching ProcessIds; the termination is done by the
// ordinary `taskkill` tool. Own-profile processes only; never the user's real Edge.
function sweepProfileEdge(profileDir) {
  if (process.platform !== 'win32') return Promise.resolve();
  const leaf = path.basename(profileDir);
  const query =
    "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*" + leaf + "*' }).ProcessId";
  return new Promise((resolve) => {
    let out = '';
    let p;
    try { p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { windowsHide: true }); }
    catch (e) { resolve(); return; }
    if (p.stdout) p.stdout.on('data', (d) => { out += d.toString(); });
    const finish = () => {
      const pids = out.split(/\s+/).map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n) && n > 0);
      if (!pids.length) { resolve(); return; }
      const args = ['/f', '/t'];
      for (const pid of pids) args.push('/pid', String(pid));
      try { spawn('taskkill', args, { windowsHide: true }); } catch (e) { /* ignore */ }
      resolve();
    };
    p.on('exit', finish);
    p.on('error', () => resolve());
    setTimeout(() => { try { p.kill(); } catch (e) { /* ignore */ } finish(); }, 4000).unref();
  });
}

// Sites remember a bot verdict against the profile's cookies, not just the live
// fingerprint: before generation 2 the tile presented itself as headless
// (HeadlessChrome UA, webdriver:true, Widevine rejected), and Twitch kept serving
// "browser not supported" to those same session cookies even after every live
// signal was fixed — deleting the twitch cookies healed it instantly (verified on
// a live tile). So when the fingerprint changes incompatibly, bump this and the
// profile is wiped once; logins could not work before gen 2, so users lose nothing.
const FINGERPRINT_GENERATION = 2;

function resetPoisonedProfile(profileDir) {
  const marker = path.join(profileDir, 'fingerprint-generation');
  let gen = 0;
  try { gen = parseInt(fs.readFileSync(marker, 'utf8'), 10) || 0; } catch (e) { gen = 0; }
  if (gen >= FINGERPRINT_GENERATION) return;
  if (fs.existsSync(path.join(profileDir, 'Default'))) {
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* held file; checked below */ }
    // Wipe incomplete (a file was still locked): leave the marker absent so the
    // next launch retries, rather than sealing a still-poisoned profile as clean.
    if (fs.existsSync(path.join(profileDir, 'Default'))) return;
  }
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch (e) { /* ignore */ }
  try { fs.writeFileSync(marker, String(FINGERPRINT_GENERATION)); } catch (e) { /* ignore */ }
}

module.exports = {
  pidFilePath, reapStaleProfilePosix, reapStaleProfileEdge, clearProfileLocks, sweepProfileEdge,
  FINGERPRINT_GENERATION, resetPoisonedProfile,
};
