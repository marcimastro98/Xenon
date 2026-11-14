'use strict';
// What the disk space module may delete: the guard's view of this machine, a path looked at
// again just before it goes, and whether anything here can put a file in the bin.

const path = require('node:path');
const fs = require('node:fs');
const DiskGuard = require('../disk-guard.js');
const { DU_WALK_CAP } = require('./limits.js');

function makeDeleteGuard({
  dataDir, helperExe, appRoot, shellDeleteRunner, PLATFORM, IS_WIN, IS_MAC, userProfile, windir,
  programFiles, programFilesX86, tempDirs, xdgDirs, known, containerDirs, oneDrive,
}) {
  function guardCtx(root) {
    return DiskGuard.buildGuardCtx({
      platform: PLATFORM,
      windir, programFiles, programFilesX86,
      documents: known('Documents'), pictures: known('Pictures'), desktop: known('Desktop'),
      music: known('Music'),
      // macOS calls it Movies; the guard key stays `videos` so the refusal
      // reason does not change per platform.
      videos: known(IS_MAC ? 'Movies' : 'Videos'),
      dataDir, appRoot, userProfile, root,
      // Consulted only to exempt a path from the POSIX system-root list.
      tempDirs,
      // The localised names, in addition to the English ones above.
      extraProtected: [
        ['documents', xdgDirs.documents], ['pictures', xdgDirs.pictures],
        ['desktop', xdgDirs.desktop], ['music', xdgDirs.music],
        ['videos', xdgDirs.videos], ['documents', xdgDirs.templates],
        ['documents', xdgDirs.publicshare],
      ].filter(([, p]) => !!p).map(([key, p]) => ({ key, path: p })),
    });
  }

  function isContainerDir(p) {
    return containerDirs.has(String(p || '').toLowerCase().replace(/[\\/]+$/, ''));
  }

  // Live existence/reparse probe, shared by the selection check and the
  // descend path: lstat sees symlinks, but an NTFS junction needs the realpath
  // comparison (a junction must never become a delete of its target).
  async function probeFlags(p) {
    let flags = { exists: false, isReparse: false, isDir: false, size: 0 };
    try {
      const st = await fs.promises.lstat(p);
      flags = { exists: true, isReparse: st.isSymbolicLink(), isDir: st.isDirectory(), size: st.size };
      // WINDOWS ONLY. This catches a junction or a mounted volume, neither of
      // which lstat reports as a link there. Off Windows the same comparison is
      // not a stricter test, it is a broken one: realpath resolves the WHOLE
      // path, so it differs from the input whenever any ANCESTOR is a symlink —
      // and on macOS /var is a symlink to /private/var, which is where the
      // user's temp directory lives. Every directory in the temp category came
      // back `reparse` and the guard refused it: measured, the largest and most
      // useful cleanup target on the platform could never be cleaned. The
      // symlink bit above is the whole answer on POSIX.
      if (IS_WIN && !flags.isReparse && st.isDirectory()) {
        const real = await fs.promises.realpath(p).catch(() => p);
        if (real.toLowerCase() !== p.toLowerCase()) flags.isReparse = true;
      }
    } catch { /* stays exists:false */ }
    return flags;
  }

  // Bounded "what is left" walk for a partially-cleared folder: after the
  // children were recycled around a locked file, the leftover is typically a
  // few KB — walking it is cheap and makes the freed-bytes number honest.
  async function remainingBytes(root) {
    let total = 0, seen = 0;
    async function walk(dir) {
      if (seen >= DU_WALK_CAP) return;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (seen++ >= DU_WALK_CAP) return;
        const p = path.join(dir, e.name);
        try {
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) await walk(p);
          else if (e.isFile()) total += (await fs.promises.lstat(p)).size;
        } catch { /* vanished mid-walk */ }
      }
    }
    await walk(root);
    return seen >= DU_WALK_CAP ? null : total;   // null = too big to answer honestly
  }

  function guardDelete(abs, gctx, flags) {
    // Belt and braces: a stale cached enumeration must not be able to address
    // the container itself even if it once held it as an item.
    if (isContainerDir(abs)) return { ok: false, reason: 'container_root' };
    if (oneDrive) {
      const p = String(abs || '').toLowerCase().replace(/\//g, '\\');
      const od = oneDrive.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
      if (p === od || p.startsWith(od + '\\')) return { ok: false, reason: 'protected:oneDrive' };
    }
    return DiskGuard.guardDelete(abs, gctx, flags);
  }

  function helperPresent() {
    try { return !!helperExe && fs.existsSync(helperExe); } catch { return false; }
  }

  // Whether a reversible delete can be performed at all. The helper is one way;
  // an injected runner (Linux, via `gio trash`) is another, and gating cleanup
  // on the BINARY rather than on the capability meant a platform with a working
  // trash was still told to install a companion it has no build of.
  function canRecycle() {
    return helperPresent() || !!shellDeleteRunner;
  }

  return {
    guardCtx, isContainerDir, probeFlags, remainingBytes, guardDelete, helperPresent, canRecycle,
  };
}

module.exports = { makeDeleteGuard };
