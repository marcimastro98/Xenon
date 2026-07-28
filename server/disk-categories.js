'use strict';

// ── Disk space: the CLOSED "safe to clean" category list (pure logic) ───────
// Deleting the wrong file is the single most damaging thing this product could
// do to a user, so what is offered for deletion is a closed list defined HERE,
// by us — never inferred from heuristics and never chosen by the AI. Anything
// this module does not positively classify is SHOWN with its size in the disk
// widget but gets no delete button. The rules come from .claude/FUTURE.md and
// are deliberately conservative; widening a category is a product decision,
// not a refactor.
//
// This module only CLASSIFIES. The hard blocklist that can veto any deletion
// regardless of category lives in disk-guard.js and wins over everything here;
// the actual deletion is always a move to the Recycle Bin / Trash, in the
// helper.
//
// Pure: no fs, no process.env — the caller (diskspace.js) resolves the real
// machine paths once and passes them in as `ctx`, which is what makes every
// rule below unit-testable (test/disk-categories.test.mjs).
//
// ── Cross-platform note (v4.11.0) ──────────────────────────────────────────
// The category ids are unchanged and stay unchanged: they travel to the client
// and back in /disk/clean requests, so `recycleBin` still names the category
// even where the thing is called the Trash. What differs per platform is only
// which paths land in each one.
//
// Case handling is the mirror image of disk-guard.js and for the same reason.
// A blocklist is safe when it over-matches; an ALLOWLIST is safe when it
// under-matches, because every extra match is another delete button. So these
// comparisons are case-SENSITIVE off Windows, where the filesystem may well be
// too, and stay case-insensitive on Windows, where NTFS is not. A directory
// that fails to classify because of its capitalisation is shown with its size
// and no button, which is the correct failure.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.DiskCategories = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // Category ids, stable — they travel to the client and back in /disk/clean
  // requests, so renaming one is a wire-contract change.
  const CATEGORIES = ['temp', 'browserCache', 'pkgCache', 'buildOutput', 'recycleBin', 'installers'];

  const DAY_MS = 86400000;

  const isWin = (platform) => (platform || 'win32') === 'win32';

  function stripPrivate(p) {
    const m = /^\/private(\/(?:var|tmp|etc)(?:\/|$))/.exec(p);
    return m ? p.slice('/private'.length) : p;
  }

  function normPath(p, platform) {
    const raw = String(p == null ? '' : p);
    if (isWin(platform)) {
      return raw.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    }
    // No separator rewriting (a backslash is a legal filename character here)
    // and no case folding (see the header).
    let s = stripPrivate(raw.replace(/\/{2,}/g, '/'));
    if (s !== '/') s = s.replace(/\/+$/, '');
    return s;
  }

  const sepOf = (platform) => (isWin(platform) ? '\\' : '/');

  // Is `p` equal to or under `prefix`? Segment-safe: "C:\Tempx" is not under
  // "C:\Temp", and "/tmpx" is not under "/tmp".
  function under(p, prefix, platform) {
    if (!prefix) return false;
    const a = normPath(p, platform), b = normPath(prefix, platform);
    if (!b) return false;
    if (!isWin(platform) && b === '/') return a.startsWith('/');
    return a === b || a.startsWith(b + sepOf(platform));
  }

  // ── Windows vocabulary (unchanged) ────────────────────────────────────────

  // Cache-ish directory segments inside a browser profile. Only these — a
  // browser's User Data also holds bookmarks, passwords and cookies, which is
  // exactly why "under the browser dir" alone must never classify.
  const BROWSER_CACHE_SEGMENT = /\\(cache|code cache|gpucache|cache_data|cachestorage|shadercache|dawncache|graphitedawncache|cache2|jumplisticonsmostvisited|media cache)(\\|$)/;

  // Browser vendor roots, relative to %LocalAppData% — the cache segment must
  // appear INSIDE one of these.
  const BROWSER_VENDOR_DIRS = [
    'google\\chrome', 'microsoft\\edge', 'bravesoftware\\brave-browser',
    'mozilla\\firefox', 'opera software', 'vivaldi', 'chromium',
  ];

  // Package-manager caches whose whole point is being re-downloadable.
  // Relative to %LocalAppData% or the user profile as noted.
  const PKG_CACHE_LOCAL = ['npm-cache', 'pip\\cache', 'nuget\\v3-cache', 'yarn\\cache', 'pnpm\\store', 'go-build', 'electron\\cache', 'pypoetry\\cache', 'uv\\cache'];
  const PKG_CACHE_PROFILE = ['.gradle\\caches', '.cargo\\registry\\cache', '.m2\\repository', '.nuget\\packages', '.composer\\cache'];

  const INSTALLER_EXTS = new Set(['exe', 'msi', 'msix', 'appx']);

  // ── POSIX vocabulary ──────────────────────────────────────────────────────
  // Every entry is profile-relative, so one table serves macOS and Linux and
  // the differences stay visible instead of hiding behind a platform branch.
  // Cache directories that hold more than a cache (Xcode's iOS DeviceSupport,
  // which you need to debug a device running an older OS) are deliberately
  // absent: they are shown with their size and no button.

  // Relative to the profile. macOS keeps browser caches in ~/Library/Caches,
  // where the whole directory is regenerable by Apple's own definition; Linux
  // follows XDG and keeps them in ~/.cache.
  const BROWSER_CACHE_DARWIN = [
    'Library/Caches/Google/Chrome', 'Library/Caches/com.google.Chrome',
    'Library/Caches/Chromium', 'Library/Caches/org.chromium.Chromium',
    'Library/Caches/Firefox', 'Library/Caches/Mozilla',
    'Library/Caches/com.apple.Safari',
    'Library/Caches/Microsoft Edge', 'Library/Caches/com.microsoft.edgemac',
    'Library/Caches/BraveSoftware', 'Library/Caches/com.brave.Browser',
    'Library/Caches/com.operasoftware.Opera', 'Library/Caches/Vivaldi',
    'Library/Caches/com.vivaldi.Vivaldi',
  ];
  const BROWSER_CACHE_LINUX = [
    '.cache/google-chrome', '.cache/chromium', '.cache/mozilla/firefox',
    '.cache/BraveSoftware', '.cache/microsoft-edge', '.cache/opera',
    '.cache/vivaldi',
  ];

  const PKG_CACHE_DARWIN = [
    '.npm/_cacache', '.cargo/registry/cache', '.gradle/caches', '.m2/repository',
    '.composer/cache', '.nuget/packages', '.yarn/cache', '.pnpm-store',
    'Library/Caches/pip', 'Library/Caches/Homebrew', 'Library/Caches/pypoetry',
    'Library/Caches/uv', 'Library/Caches/go-build', 'Library/Caches/node-gyp',
    'Library/Caches/electron', 'Library/Caches/electron-builder',
    'Library/Caches/ms-playwright', 'Library/Caches/CocoaPods',
    'Library/Developer/CoreSimulator/Caches',
  ];
  const PKG_CACHE_LINUX = [
    '.npm/_cacache', '.cargo/registry/cache', '.gradle/caches', '.m2/repository',
    '.composer/cache', '.nuget/packages', '.yarn/cache',
    '.local/share/pnpm/store', '.cache/pip', '.cache/go-build', '.cache/uv',
    '.cache/yarn', '.cache/electron', '.cache/ms-playwright', '.cache/node-gyp',
    '.cache/pypoetry',
  ];

  // Xcode's build products. The one build output that classifies OUTSIDE a
  // declared dev folder, because the directory exists for nothing else and is
  // the largest single reclaimable thing on a developer's Mac. Only strict
  // children: the DerivedData folder itself is a container Xcode recreates and
  // expects to find (same rule as %TEMP%).
  const DERIVED_DATA = 'Library/Developer/Xcode/DerivedData';

  const BUILD_DIR_NAMES_POSIX = new Set(['.build']);

  const INSTALLER_EXTS_DARWIN = new Set(['dmg', 'pkg', 'mpkg']);
  const INSTALLER_EXTS_LINUX = new Set(['deb', 'rpm', 'appimage', 'snap', 'flatpak']);

  // ── shared ────────────────────────────────────────────────────────────────

  // Build-output directory names. Classified ONLY under a dev folder the user
  // explicitly added in Settings — "node_modules" anywhere else is shown, not
  // deletable.
  const BUILD_DIR_NAMES = new Set(['node_modules', 'target', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.parcel-cache', 'obj']);
  // "bin" alone is too generic even under a dev folder (plenty of tools ship
  // real binaries in bin/): only classify it when a sibling project marker was
  // seen — the scanner passes `hasProjectMarker` for that.
  const BUILD_DIR_NAMES_MARKED = new Set(['bin']);

  // Classify one scanned entry. Returns { cat } or null (= not cleanable).
  //
  // entry: { path, name, isDir, ext, mtime, hasProjectMarker? }
  // ctx:   { platform, tempDirs: [], localAppData, userProfile, windir,
  //          systemDirs: [], trashDirs: [], devFolders: [], downloads,
  //          installerAgeDays, now }
  function classify(entry, ctx) {
    if (!entry || typeof entry.path !== 'string' || !ctx) return null;
    const platform = ctx.platform || (typeof process !== 'undefined' ? process.platform : 'win32');
    return isWin(platform) ? classifyWin(entry, ctx, platform) : classifyPosix(entry, ctx, platform);
  }

  function classifyWin(entry, ctx, platform) {
    const p = normPath(entry.path, platform);

    // Recycle Bin contents: reported so the widget can offer "empty the bin"
    // (the one action that IS permanent and says so — its contents are already
    // the undo of previous deletes).
    if (/^[a-z]:\\\$recycle\.bin(\\|$)/.test(p)) return { cat: 'recycleBin' };

    // Nothing under %WINDIR% classifies, deliberately and before every other
    // rule. There used to be a 'winUpdate' category for
    // C:\Windows\SoftwareDistribution\Download, and C:\Windows\Temp used to
    // arrive here as a temp dir — both were offered with a Clean button that
    // could never work: disk-guard.js protects the whole Windows directory, so
    // every one of those paths came back `protected:windir`, and even without
    // the guard those ACLs need an elevation Xenon does not have. A category
    // that always refuses is worse than no category; these are shown with their
    // size in the map like any other system folder and get no button. Re-adding
    // needs the guard carve-out AND an elevation story, in that order.
    if (ctx.windir && under(p, ctx.windir, platform)) return null;

    for (const t of ctx.tempDirs || []) {
      if (under(p, t, platform)) return { cat: 'temp' };
    }

    const lad = normPath(ctx.localAppData || '', platform);
    if (lad && p.startsWith(lad + '\\')) {
      const rel = p.slice(lad.length + 1);
      for (const vendor of BROWSER_VENDOR_DIRS) {
        if (rel.startsWith(vendor + '\\') && BROWSER_CACHE_SEGMENT.test('\\' + rel)) {
          return { cat: 'browserCache' };
        }
      }
      for (const c of PKG_CACHE_LOCAL) {
        if (rel === c || rel.startsWith(c + '\\')) return { cat: 'pkgCache' };
      }
    }

    const prof = normPath(ctx.userProfile || '', platform);
    if (prof && p.startsWith(prof + '\\')) {
      const rel = p.slice(prof.length + 1);
      for (const c of PKG_CACHE_PROFILE) {
        if (rel === c || rel.startsWith(c + '\\')) return { cat: 'pkgCache' };
      }
    }

    const build = classifyBuild(entry, ctx, platform, BUILD_DIR_NAMES);
    if (build) return build;

    return classifyInstaller(entry, ctx, platform, INSTALLER_EXTS);
  }

  function classifyPosix(entry, ctx, platform) {
    const p = normPath(entry.path, platform);
    const sep = '/';

    // Same rule as %WINDIR% above, for the same reason: disk-guard.js refuses
    // the OS-owned roots outright, so classifying anything under them would
    // produce a Clean button that always comes back `protected:system`. The
    // caller passes the guard's own list so there is one source of truth.
    // Checked BEFORE temp, because the macOS per-user temp dir lives under
    // /var and is a legitimate exception the guard makes too.
    for (const t of ctx.tempDirs || []) {
      if (t && under(p, t, platform)) return { cat: 'temp' };
    }
    // The system-roots check is a PROTECTION (return null = never offer a
    // delete button), so — unlike every classification rule in this module —
    // it folds case. disk-guard.js protects these same roots
    // case-insensitively; matching that here is what keeps "what we refuse to
    // OFFER" and "what we refuse to DELETE" aligned. It matters on a
    // case-preserving APFS volume, where the real paths are "/System" and
    // "/Library" while SYSTEM_PREFIXES are lowercase: a case-sensitive compare
    // silently never fired and the coupling was dead on the one platform it was
    // added for. Over-matching a protection is the safe direction.
    const pFold = p.toLowerCase();
    for (const sys of ctx.systemDirs || []) {
      if (under(pFold, sys, platform)) return null;
    }

    // The Trash. Reported so the widget can offer "empty" — the one permanent
    // action, and it says so, because its contents are already the undo of
    // previous deletes.
    for (const t of ctx.trashDirs || []) {
      if (t && under(p, t, platform)) return { cat: 'recycleBin' };
    }

    const prof = normPath(ctx.userProfile || '', platform);
    if (prof && p.startsWith(prof + sep)) {
      const rel = p.slice(prof.length + 1);
      const isDarwin = platform === 'darwin';

      for (const c of (isDarwin ? BROWSER_CACHE_DARWIN : BROWSER_CACHE_LINUX)) {
        if (rel === c || rel.startsWith(c + sep)) return { cat: 'browserCache' };
      }
      for (const c of (isDarwin ? PKG_CACHE_DARWIN : PKG_CACHE_LINUX)) {
        if (rel === c || rel.startsWith(c + sep)) return { cat: 'pkgCache' };
      }
      // Strict children of DerivedData only — never the folder itself.
      if (isDarwin && rel.startsWith(DERIVED_DATA + sep) && rel.length > DERIVED_DATA.length + 1) {
        return { cat: 'buildOutput' };
      }
    }

    const names = new Set([...BUILD_DIR_NAMES, ...BUILD_DIR_NAMES_POSIX]);
    const build = classifyBuild(entry, ctx, platform, names);
    if (build) return build;

    return classifyInstaller(entry, ctx, platform,
      platform === 'darwin' ? INSTALLER_EXTS_DARWIN : INSTALLER_EXTS_LINUX);
  }

  function classifyBuild(entry, ctx, platform, names) {
    if (!entry.isDir) return null;
    const p = normPath(entry.path, platform);
    const name = normPath(entry.name, platform);
    const isBuild = names.has(name) || (BUILD_DIR_NAMES_MARKED.has(name) && entry.hasProjectMarker === true);
    if (!isBuild) return null;
    for (const dev of ctx.devFolders || []) {
      if (under(p, dev, platform) && p !== normPath(dev, platform)) return { cat: 'buildOutput' };
    }
    return null;
  }

  function classifyInstaller(entry, ctx, platform, exts) {
    if (entry.isDir || !ctx.downloads) return null;
    const p = normPath(entry.path, platform);
    if (!under(p, ctx.downloads, platform)) return null;
    // Case-folded even on POSIX: an extension is a naming convention, not a
    // path, and ".AppImage" is how that one is actually written.
    const ext = String(entry.ext || '').toLowerCase().replace(/^\./, '');
    const ageDays = (Number.isFinite(ctx.now) && Number.isFinite(entry.mtime)) ? (ctx.now - entry.mtime) / DAY_MS : 0;
    const minAge = Number.isFinite(ctx.installerAgeDays) ? ctx.installerAgeDays : 30;
    if (exts.has(ext) && ageDays > minAge) return { cat: 'installers' };
    return null;
  }

  return { classify, CATEGORIES, DERIVED_DATA };
});
