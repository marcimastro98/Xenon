'use strict';

// ── Disk space: the hard deletion blocklist (pure logic) ────────────────────
// The last gate before any path reaches the helper's recycle-bin delete, and
// it WINS over everything: a path can carry a valid category from
// disk-categories.js and still be refused here. The categories say what we
// offer; this module says what we will never touch:
//
//   * system directories (Windows, Program Files, Program Files (x86))
//   * the user's personal folders (Documents, Pictures, Desktop, Music, Videos)
//     and the user-profile root itself
//   * Xenon's own install root and DATA_DIR (the app must never delete itself
//     or its users' data)
//   * anything reached through a reparse point — the caller lstat()s and
//     passes the flag; same rule and same reason as update-apply.ps1's stale
//     cleanup
//   * anything outside the root the scan actually enumerated, drive roots and
//     first-level directories as such
//
// The client never sends a path (it sends category + item ids resolved against
// the server's own enumeration); this guard re-checks the RESOLVED path anyway,
// so a bug upstream degrades to "refused", never to "deleted".
//
// Pure: the caller resolves real paths/flags and passes them in, which is what
// makes every refusal testable (test/disk-guard.test.mjs).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.DiskGuard = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  function normPath(p) {
    return String(p == null ? '' : p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  }

  function under(p, prefix) {
    if (!prefix) return false;
    const a = normPath(p), b = normPath(prefix);
    return a === b || a.startsWith(b + '\\');
  }

  // Build the guard context once per machine (diskspace.js resolves the real
  // folders and calls this at startup). Every field is a prefix that refuses.
  function buildGuardCtx(opts) {
    const o = opts || {};
    const protectedPrefixes = [];
    for (const key of ['windir', 'programFiles', 'programFilesX86', 'documents', 'pictures', 'desktop', 'music', 'videos', 'dataDir', 'appRoot']) {
      if (o[key]) protectedPrefixes.push({ key, path: normPath(o[key]) });
    }
    return {
      protectedPrefixes,
      userProfile: o.userProfile ? normPath(o.userProfile) : '',
      root: o.root ? normPath(o.root) : '',
    };
  }

  // Decide one resolved path. flags: { exists, isReparse } — resolved by the
  // caller against the live filesystem immediately before deletion (a re-stat,
  // not the scan-time snapshot: the disk can change between scan and click).
  // Returns { ok: true } or { ok: false, reason }.
  function guardDelete(absPath, guardCtx, flags) {
    const f = flags || {};
    const raw = String(absPath == null ? '' : absPath);
    // Absolute drive path, no traversal left after normalization. Forward
    // slashes are normalized away; a UNC path is refused outright (the scan
    // only ever enumerates local drives).
    if (!/^[a-zA-Z]:[\\/]/.test(raw)) return { ok: false, reason: 'not_absolute' };
    if (/(^|[\\/])\.\.([\\/]|$)/.test(raw)) return { ok: false, reason: 'traversal' };
    const p = normPath(raw);

    if (f.exists !== true) return { ok: false, reason: 'missing' };
    if (f.isReparse === true) return { ok: false, reason: 'reparse' };

    if (!guardCtx || !guardCtx.root) return { ok: false, reason: 'no_root' };
    if (!under(p, guardCtx.root)) return { ok: false, reason: 'off_root' };

    // Never a drive root or a first-level directory as such — categories only
    // ever select things deeper than that, so anything this shallow is a bug.
    const segments = p.split('\\').filter(Boolean); // ["c:", "users", ...]
    if (segments.length < 3) return { ok: false, reason: 'too_shallow' };

    for (const pref of guardCtx.protectedPrefixes) {
      if (under(p, pref.path)) return { ok: false, reason: 'protected:' + pref.key };
    }
    // The user-profile ROOT itself (its subtrees are decided by the prefixes
    // above and the category rules — caches under AppData are legitimate).
    if (guardCtx.userProfile && p === guardCtx.userProfile) return { ok: false, reason: 'protected:userProfile' };

    return { ok: true };
  }

  return { buildGuardCtx, guardDelete };
});
