'use strict';

// ── Disk space: the hard deletion blocklist (pure logic) ────────────────────
// The last gate before any path reaches the helper's recycle-bin delete, and
// it WINS over everything: a path can carry a valid category from
// disk-categories.js and still be refused here. The categories say what we
// offer; this module says what we will never touch:
//
//   * system directories (Windows, Program Files, Program Files (x86); on
//     POSIX the OS-owned roots — see SYSTEM_PREFIXES)
//   * the user's personal folders (Documents, Pictures, Desktop, Music,
//     Videos/Movies) and the user-profile root itself
//   * Xenon's own install root and DATA_DIR (the app must never delete itself
//     or its users' data)
//   * anything reached through a reparse point — the caller lstat()s and
//     passes the flag; same rule and same reason as update-apply.ps1's stale
//     cleanup
//   * anything outside the root the scan actually enumerated, drive roots,
//     mount roots and first-level directories as such
//
// The client never sends a path (it sends category + item ids resolved against
// the server's own enumeration); this guard re-checks the RESOLVED path anyway,
// so a bug upstream degrades to "refused", never to "deleted".
//
// Pure: the caller resolves real paths/flags and passes them in, which is what
// makes every refusal testable (test/disk-guard.test.mjs).
//
// ── Cross-platform note (v4.11.0) ──────────────────────────────────────────
// Every comparison here used to assume a Windows path: backslashes, a drive
// letter, and case-insensitive matching. Two of those are wrong on POSIX and
// the third is only half wrong, so the rules below are explicit about which
// direction each comparison is allowed to err in:
//
//   * A BACKSLASH IS A LEGAL FILENAME CHARACTER on POSIX. Translating it to a
//     separator the way the Windows path does would merge two distinct files
//     into one comparison, so separators are never rewritten off Windows.
//   * PROTECTION checks compare case-INSENSITIVELY everywhere. On a
//     case-sensitive filesystem that over-matches, and over-matching a
//     blocklist means refusing more than strictly necessary. That is the safe
//     direction.
//   * The ROOT-CONTAINMENT check compares case-SENSITIVELY on POSIX. It is the
//     one test whose failure mode is inverted: `under(path, root)` returning
//     true is what ALLOWS a path through, so a loose comparison there would
//     admit an off-root path rather than refuse an on-root one.
//
// Same rule stated once: every comparison is arranged so that being wrong
// means refusing a deletion, never performing one.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.DiskGuard = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  const isWin = (platform) => (platform || 'win32') === 'win32';

  // OS-owned trees on POSIX. Broad on purpose: the categories in
  // disk-categories.js are a closed allowlist and none of them resolves inside
  // these, so protecting the whole set costs nothing real and catches an
  // upstream bug that invented a path we never meant to offer.
  //
  // `/var` is here even though the macOS per-user temp dir lives under it
  // (`/var/folders/<xx>/<yyy>/T`). That is what `tempDirs` in the guard context
  // is for: a path STRICTLY BELOW a temp directory the caller resolved from the
  // environment is exempt from THIS list and nothing else. The exemption never
  // reaches the personal-folder prefixes, the reparse rule, the depth rule or
  // the root check.
  const SYSTEM_PREFIXES = [
    '/system', '/library', '/applications', '/bin', '/sbin', '/usr', '/etc',
    '/var', '/opt', '/srv', '/run', '/boot', '/proc', '/sys', '/dev',
    '/lib', '/lib32', '/lib64', '/libexec', '/root', '/cores', '/network',
    '/snap', '/nix', '/efi',
  ];

  // Directories whose CHILDREN are mount points or home directories, so a
  // depth-2 path under one of them is a volume/home root as such — the POSIX
  // equivalent of `C:\` and never an item a category selected.
  const MOUNT_PARENTS = ['/volumes', '/users', '/home', '/media', '/mnt', '/net'];

  // macOS reaches the same directories through two spellings: `/var`, `/tmp`
  // and `/etc` are firmlinks to `/private/var`, `/private/tmp` and
  // `/private/etc`. `os.tmpdir()` answers with one form and a resolved path can
  // arrive in the other, so the two are folded together before any comparison.
  // Without this the temp exemption above silently stops matching, which is a
  // safe failure (everything refuses) but a broken feature.
  function stripPrivate(p) {
    const m = /^\/private(\/(?:var|tmp|etc)(?:\/|$))/.exec(p);
    return m ? p.slice('/private'.length) : p;
  }

  // `fold` decides whether case survives. Protection checks fold; the root
  // check does not (see the header).
  function normPath(p, platform, fold) {
    const raw = String(p == null ? '' : p);
    if (isWin(platform)) {
      // NTFS is case-insensitive and both separators are separators, so the
      // Windows normalisation is unchanged from the original module.
      return raw.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    }
    // Separators are NOT rewritten: a backslash is an ordinary character here.
    let s = stripPrivate(raw.replace(/\/{2,}/g, '/'));
    if (s !== '/') s = s.replace(/\/+$/, '');
    return fold === false ? s : s.toLowerCase();
  }

  const sepOf = (platform) => (isWin(platform) ? '\\' : '/');

  function under(p, prefix, platform, fold) {
    if (!prefix) return false;
    const a = normPath(p, platform, fold), b = normPath(prefix, platform, fold);
    if (!b) return false;
    // The filesystem root contains everything absolute; `b + '/'` would be
    // "//" and match nothing.
    if (!isWin(platform) && b === '/') return a.startsWith('/');
    return a === b || a.startsWith(b + sepOf(platform));
  }

  // Build the guard context once per machine (diskspace.js resolves the real
  // folders and calls this at startup). Every field is a prefix that refuses.
  function buildGuardCtx(opts) {
    const o = opts || {};
    const platform = o.platform || (typeof process !== 'undefined' ? process.platform : 'win32');
    const protectedPrefixes = [];
    for (const key of ['windir', 'programFiles', 'programFilesX86', 'documents', 'pictures', 'desktop', 'music', 'videos', 'dataDir', 'appRoot']) {
      if (o[key]) protectedPrefixes.push({ key, path: normPath(o[key], platform, true) });
    }
    // Additional prefixes the caller resolved for this machine, refusing under
    // an existing key's name. This is how the localised XDG user directories
    // are covered on Linux: `~/Documenti` and `~/Documents` are both protected,
    // and the refusal still reads `protected:documents`. Adding prefixes only
    // ever refuses more, so this cannot widen what is deletable.
    for (const extra of (Array.isArray(o.extraProtected) ? o.extraProtected : [])) {
      if (extra && extra.path && extra.key) {
        protectedPrefixes.push({ key: String(extra.key), path: normPath(extra.path, platform, true) });
      }
    }
    return {
      platform,
      protectedPrefixes,
      userProfile: o.userProfile ? normPath(o.userProfile, platform, true) : '',
      root: o.root ? normPath(o.root, platform, false) : '',
      // Only consulted to exempt a path from SYSTEM_PREFIXES (POSIX).
      tempDirs: (Array.isArray(o.tempDirs) ? o.tempDirs : [])
        .filter((d) => typeof d === 'string' && d)
        .map((d) => normPath(d, platform, true)),
    };
  }

  // Decide one resolved path. flags: { exists, isReparse } — resolved by the
  // caller against the live filesystem immediately before deletion (a re-stat,
  // not the scan-time snapshot: the disk can change between scan and click).
  // Returns { ok: true } or { ok: false, reason }.
  function guardDelete(absPath, guardCtx, flags) {
    const f = flags || {};
    const raw = String(absPath == null ? '' : absPath);
    const platform = (guardCtx && guardCtx.platform) || (typeof process !== 'undefined' ? process.platform : 'win32');
    const win = isWin(platform);

    // Absolute path, no traversal left after normalization. On Windows: a drive
    // path with either separator; a UNC path is refused outright (the scan only
    // ever enumerates local drives). On POSIX: rooted at `/`, which also refuses
    // the `~` shorthand — this guard only ever sees paths the server itself
    // resolved, and an unexpanded tilde means something upstream did not.
    if (win) {
      if (!/^[a-zA-Z]:[\\/]/.test(raw)) return { ok: false, reason: 'not_absolute' };
      if (/(^|[\\/])\.\.([\\/]|$)/.test(raw)) return { ok: false, reason: 'traversal' };
    } else {
      if (!/^\//.test(raw)) return { ok: false, reason: 'not_absolute' };
      if (/(^|\/)\.\.(\/|$)/.test(raw)) return { ok: false, reason: 'traversal' };
    }

    if (f.exists !== true) return { ok: false, reason: 'missing' };
    if (f.isReparse === true) return { ok: false, reason: 'reparse' };

    if (!guardCtx || !guardCtx.root) return { ok: false, reason: 'no_root' };
    // Case-sensitive off Windows: this is the one comparison whose loose form
    // would ADMIT a path rather than refuse one.
    if (!under(raw, guardCtx.root, platform, false)) return { ok: false, reason: 'off_root' };

    const p = normPath(raw, platform, true);

    // Never a drive/volume root or a first-level directory as such — categories
    // only ever select things deeper than that, so anything this shallow is a
    // bug. On Windows the segments include the drive ("c:"), so the same intent
    // is three segments there and two here.
    const segments = p.split(sepOf(platform)).filter(Boolean);
    if (win) {
      if (segments.length < 3) return { ok: false, reason: 'too_shallow' };
    } else {
      if (segments.length < 2) return { ok: false, reason: 'too_shallow' };
      // `/Volumes/Backup`, `/home/other` — depth 2, but a mount or home root.
      if (segments.length === 2 && MOUNT_PARENTS.includes('/' + segments[0])) {
        return { ok: false, reason: 'too_shallow' };
      }
    }

    for (const pref of guardCtx.protectedPrefixes) {
      if (under(p, pref.path, platform, true)) return { ok: false, reason: 'protected:' + pref.key };
    }

    if (!win) {
      // Somebody else's home directory. `/Users` and `/home` cannot go in
      // SYSTEM_PREFIXES — the user's OWN home is where nearly every category
      // lives — so the rule is expressed as what it actually means: a home
      // directory that is not this user's is off limits, whatever the scan
      // root says.
      if (segments.length >= 2 && (segments[0] === 'users' || segments[0] === 'home')) {
        const home = '/' + segments[0] + '/' + segments[1];
        if (!guardCtx.userProfile || !under(home, guardCtx.userProfile, platform, true)) {
          return { ok: false, reason: 'protected:otherUser' };
        }
      }

      const temps = guardCtx.tempDirs || [];
      // STRICTLY below a temp dir: the temp directory itself is resolved from
      // the environment by every running process and is never an item (see
      // isContainerDir in diskspace.js, which refuses it a second time).
      const inTemp = temps.some((t) => t && p !== t && under(p, t, platform, true));
      if (!inTemp) {
        for (const sys of SYSTEM_PREFIXES) {
          if (under(p, sys, platform, true)) return { ok: false, reason: 'protected:system' };
        }
      }
    }

    // The user-profile ROOT itself (its subtrees are decided by the prefixes
    // above and the category rules — caches under AppData / ~/Library are
    // legitimate).
    if (guardCtx.userProfile && p === guardCtx.userProfile) return { ok: false, reason: 'protected:userProfile' };

    return { ok: true };
  }

  return { buildGuardCtx, guardDelete, SYSTEM_PREFIXES, MOUNT_PARENTS };
});
