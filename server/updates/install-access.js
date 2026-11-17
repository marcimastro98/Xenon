'use strict';
// An engine in a folder its own user cannot write.
//
// The engine runs at normal rights and its folder is the user's to change
// (install.ps1, Register-StartupTask): every installer puts it in a per-user
// folder. One that someone placed under Program Files by hand breaks that, and
// the self-update is where it shows: the download cannot be saved into
// server\data\update (EPERM on download.zip, reported Nov 2026), and the files
// an elevated update left there cannot be removed by the next one. Retrying
// never helps and the setup cannot help either, since it leaves an existing
// engine to update itself.
//
// So, on the user's own Update tap and only when the staging folder really is
// not writable, grant-install-access.ps1 asks Windows once (UAC) to give this
// account write access to Xenon's own folder: the same grant a support reply
// gave by hand. After that the install behaves like any per-user one. The
// automatic updater never asks: nobody is there to answer a prompt.

const path = require('path');

const GRANT_SCRIPT = 'grant-install-access.ps1';
// grant-install-access.ps1's exit code when the UAC prompt was declined.
const EXIT_DECLINED = 3;
// A prompt nobody answers must not hold the Update request forever.
const GRANT_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * True when `dir` could be emptied of `leftovers` and written to.
 * @param {typeof import('fs')} f
 * @param {string} dir
 * @param {string[]} leftovers paths a stale run may have left that must be gone
 */
function stagingReady(f, dir, leftovers) {
  try { f.rmSync(dir, { recursive: true, force: true }); } catch { /* judged below */ }
  try {
    f.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.xenon-write-test');
    f.writeFileSync(probe, '');
    f.rmSync(probe, { force: true });
    return leftovers.every((p) => !f.existsSync(p));
  } catch {
    return false;
  }
}

/**
 * @param {{ root: string, platform: string, fsImpl: typeof import('fs'),
 *   spawn: Function, psExe: string, timeoutMs?: number }} o
 */
function createInstallAccess(o) {
  const f = o.fsImpl;
  const script = path.join(o.root, 'server', GRANT_SCRIPT);
  const timeoutMs = o.timeoutMs || GRANT_TIMEOUT_MS;

  function canGrant() {
    if (o.platform !== 'win32') return false;
    try { return f.existsSync(script); } catch { return false; }
  }

  /** Runs the grant; resolves '' when it ran to the end, else the reason it did not. */
  function grant() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(reason);
      };
      const timer = setTimeout(() => finish('access_declined'), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      let child;
      try {
        // A console of its own, like the elevated updater: the UAC prompt needs a window.
        child = o.spawn(o.psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
          { windowsHide: false, stdio: 'ignore' });
      } catch {
        finish('install_protected');
        return;
      }
      child.on('error', () => finish('install_protected'));
      child.on('exit', (code) => finish(code === 0 ? '' : code === EXIT_DECLINED ? 'access_declined' : 'install_protected'));
    });
  }

  /**
   * Makes `dir` ready for a new download, asking for access when allowed and needed.
   * Throws 'install_protected' or 'access_declined' when it stays unwritable.
   * @param {string} dir
   * @param {string[]} leftovers
   * @param {boolean} allowGrant only on a tap by someone at the PC
   */
  async function ensureStaging(dir, leftovers, allowGrant) {
    if (stagingReady(f, dir, leftovers)) return;
    if (!allowGrant || !canGrant()) throw new Error('install_protected');
    const reason = await grant();
    if (stagingReady(f, dir, leftovers)) return;
    throw new Error(reason || 'install_protected');
  }

  return { ensureStaging, canGrant, scriptPath: script };
}

module.exports = { createInstallAccess, stagingReady, GRANT_SCRIPT, EXIT_DECLINED };
