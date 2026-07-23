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
// the actual deletion is always SHFileOperation → Recycle Bin, in the helper.
//
// Pure: no fs, no process.env — the caller (diskspace.js) resolves the real
// machine paths once and passes them in as `ctx`, which is what makes every
// rule below unit-testable (test/disk-categories.test.mjs).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.DiskCategories = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // Category ids, stable — they travel to the client and back in /disk/clean
  // requests, so renaming one is a wire-contract change.
  const CATEGORIES = ['temp', 'browserCache', 'pkgCache', 'buildOutput', 'recycleBin', 'installers'];

  const DAY_MS = 86400000;

  function normPath(p) {
    return String(p == null ? '' : p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  }

  // Is `p` equal to or under `prefix`? Segment-safe: "C:\Tempx" is not under
  // "C:\Temp".
  function under(p, prefix) {
    if (!prefix) return false;
    const a = normPath(p), b = normPath(prefix);
    return a === b || a.startsWith(b + '\\');
  }

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

  // Build-output directory names. Classified ONLY under a dev folder the user
  // explicitly added in Settings — "node_modules" anywhere else is shown, not
  // deletable.
  const BUILD_DIR_NAMES = new Set(['node_modules', 'target', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.parcel-cache', 'obj']);
  // "bin" alone is too generic even under a dev folder (plenty of tools ship
  // real binaries in bin/): only classify it when a sibling project marker was
  // seen — the scanner passes `hasProjectMarker` for that.
  const BUILD_DIR_NAMES_MARKED = new Set(['bin']);

  const INSTALLER_EXTS = new Set(['exe', 'msi', 'msix', 'appx']);

  // Classify one scanned entry. Returns { cat } or null (= not cleanable).
  //
  // entry: { path, name, isDir, ext, mtime, hasProjectMarker? }
  // ctx:   { tempDirs: [], localAppData, userProfile, windir, devFolders: [],
  //          downloads, installerAgeDays, now }
  function classify(entry, ctx) {
    if (!entry || typeof entry.path !== 'string' || !ctx) return null;
    const p = normPath(entry.path);

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
    if (ctx.windir && under(p, ctx.windir)) return null;

    for (const t of ctx.tempDirs || []) {
      if (under(p, t)) return { cat: 'temp' };
    }

    const lad = normPath(ctx.localAppData || '');
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

    const prof = normPath(ctx.userProfile || '');
    if (prof && p.startsWith(prof + '\\')) {
      const rel = p.slice(prof.length + 1);
      for (const c of PKG_CACHE_PROFILE) {
        if (rel === c || rel.startsWith(c + '\\')) return { cat: 'pkgCache' };
      }
    }

    if (entry.isDir) {
      const name = normPath(entry.name);
      const isBuild = BUILD_DIR_NAMES.has(name) || (BUILD_DIR_NAMES_MARKED.has(name) && entry.hasProjectMarker === true);
      if (isBuild) {
        for (const dev of ctx.devFolders || []) {
          if (under(p, dev) && p !== normPath(dev)) return { cat: 'buildOutput' };
        }
      }
    }

    if (!entry.isDir && ctx.downloads && under(p, ctx.downloads)) {
      const ext = String(entry.ext || '').toLowerCase().replace(/^\./, '');
      const ageDays = (Number.isFinite(ctx.now) && Number.isFinite(entry.mtime)) ? (ctx.now - entry.mtime) / DAY_MS : 0;
      const minAge = Number.isFinite(ctx.installerAgeDays) ? ctx.installerAgeDays : 30;
      if (INSTALLER_EXTS.has(ext) && ageDays > minAge) return { cat: 'installers' };
    }

    return null;
  }

  return { classify, CATEGORIES };
});
