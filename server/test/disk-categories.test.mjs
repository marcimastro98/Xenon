// Disk cleanup category classifier (server/disk-categories.js) — the CLOSED
// "safe to clean" list. What matters most here is what does NOT classify:
// anything unclassified is shown with no delete button, so a false negative
// costs a button while a false positive could cost user data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DC = require('../disk-categories.js');

const NOW = new Date(2026, 6, 23).getTime();
const DAY = 86400000;
const CTX = {
  // Pinned, not inferred: the module became cross-platform in v4.11.0 and
  // defaults to process.platform, so without this the Windows rules would stop
  // being exercised the moment the suite runs on the Mac.
  platform: 'win32',
  tempDirs: ['C:\\Users\\u\\AppData\\Local\\Temp', 'C:\\Windows\\Temp'],
  localAppData: 'C:\\Users\\u\\AppData\\Local',
  userProfile: 'C:\\Users\\u',
  windir: 'C:\\Windows',
  devFolders: ['C:\\Users\\u\\Desktop\\Progetti'],
  downloads: 'C:\\Users\\u\\Downloads',
  installerAgeDays: 30,
  now: NOW,
};
const cat = (entry) => {
  const r = DC.classify({ isDir: false, name: '', ext: '', mtime: NOW, ...entry }, CTX);
  return r ? r.cat : null;
};

test('temp dirs classify, look-alike siblings do not', () => {
  assert.equal(cat({ path: 'C:\\Users\\u\\AppData\\Local\\Temp\\x.tmp' }), 'temp');
  // Listed as a temp dir and STILL refused: the %WINDIR% rule runs first.
  assert.equal(cat({ path: 'C:\\Windows\\Temp\\setup.log' }), null);
  assert.equal(cat({ path: 'C:\\Users\\u\\AppData\\Local\\Temperature\\x.tmp' }), null);
});

test('browser caches: only cache segments inside vendor dirs — never the profile itself', () => {
  assert.equal(cat({ path: 'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache\\f_0001' }), 'browserCache');
  assert.equal(cat({ path: 'C:\\Users\\u\\AppData\\Local\\Microsoft\\Edge\\User Data\\Profile 1\\Code Cache\\js\\x' }), 'browserCache');
  assert.equal(cat({ path: 'C:\\Users\\u\\AppData\\Local\\Mozilla\\Firefox\\Profiles\\a.default\\cache2\\entries\\x' }), 'browserCache');
  // Bookmarks, passwords, cookies live NEXT TO the caches: must never classify.
  assert.equal(cat({ path: 'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data' }), null);
  assert.equal(cat({ path: 'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Bookmarks' }), null);
  // A "Cache" dir outside a known vendor dir is not a browser cache.
  assert.equal(cat({ path: 'C:\\Users\\u\\AppData\\Local\\MyApp\\Cache\\x' }), null);
});

test('package-manager caches classify under LocalAppData and the profile', () => {
  assert.equal(cat({ path: 'C:\\Users\\u\\AppData\\Local\\npm-cache\\_cacache\\x' }), 'pkgCache');
  assert.equal(cat({ path: 'C:\\Users\\u\\AppData\\Local\\pip\\cache\\wheels\\x.whl' }), 'pkgCache');
  assert.equal(cat({ path: 'C:\\Users\\u\\.gradle\\caches\\modules-2\\x.jar' }), 'pkgCache');
  assert.equal(cat({ path: 'C:\\Users\\u\\.nuget\\packages\\newtonsoft.json\\13.0.1' }), 'pkgCache');
  assert.equal(cat({ path: 'C:\\Users\\u\\.ssh\\id_ed25519' }), null);
});

test('build output: only under user-added dev folders, and never the dev folder itself', () => {
  const nm = { path: 'C:\\Users\\u\\Desktop\\Progetti\\app\\node_modules', name: 'node_modules', isDir: true };
  assert.equal(cat(nm), 'buildOutput');
  // Same name outside the dev folders: shown, not deletable.
  assert.equal(cat({ path: 'C:\\Users\\u\\Documents\\backup\\node_modules', name: 'node_modules', isDir: true }), null);
  // A FILE named node_modules is not a build dir.
  assert.equal(cat({ path: 'C:\\Users\\u\\Desktop\\Progetti\\node_modules', name: 'node_modules', isDir: false }), null);
});

test('bin dirs need a project marker even under a dev folder', () => {
  const bin = { path: 'C:\\Users\\u\\Desktop\\Progetti\\app\\bin', name: 'bin', isDir: true };
  assert.equal(cat(bin), null);
  assert.equal(cat({ ...bin, hasProjectMarker: true }), 'buildOutput');
});

test('the Recycle Bin classifies; nothing under \\Windows ever does', () => {
  assert.equal(cat({ path: 'C:\\$Recycle.Bin\\S-1-5-21-x\\$R1.txt' }), 'recycleBin');
  // disk-guard protects %WINDIR% outright, so anything classified there would
  // be a Clean button that always refuses. The retired 'winUpdate' category and
  // C:\Windows\Temp are pinned here so neither comes back by accident.
  assert.equal(cat({ path: 'C:\\Windows\\SoftwareDistribution\\Download\\abc123' }), null);
  assert.equal(cat({ path: 'C:\\Windows\\Temp\\leftover.tmp' }), null);
  assert.equal(cat({ path: 'C:\\Windows\\System32\\kernel32.dll' }), null);
  assert.ok(!DC.CATEGORIES.includes('winUpdate'));
});

test('installers: only in Downloads, only installer extensions, only old ones', () => {
  const old = NOW - 60 * DAY, fresh = NOW - 5 * DAY;
  assert.equal(cat({ path: 'C:\\Users\\u\\Downloads\\setup.exe', ext: 'exe', mtime: old }), 'installers');
  assert.equal(cat({ path: 'C:\\Users\\u\\Downloads\\tool.msi', ext: 'msi', mtime: old }), 'installers');
  assert.equal(cat({ path: 'C:\\Users\\u\\Downloads\\setup.exe', ext: 'exe', mtime: fresh }), null, 'too recent');
  assert.equal(cat({ path: 'C:\\Users\\u\\Downloads\\photo.jpg', ext: 'jpg', mtime: old }), null, 'not an installer');
  assert.equal(cat({ path: 'C:\\Users\\u\\Documents\\setup.exe', ext: 'exe', mtime: old }), null, 'not in Downloads');
});

test('paths never classify by name alone — user documents stay untouchable', () => {
  for (const p of [
    'C:\\Users\\u\\Documents\\tesi.docx',
    'C:\\Users\\u\\Pictures\\vacanze\\img1.jpg',
    'C:\\Program Files\\App\\app.exe',
    'D:\\Archivio\\vecchi-file\\roba.zip',
  ]) assert.equal(cat({ path: p }), null, p);
});

test('garbage input returns null, never throws', () => {
  assert.equal(DC.classify(null, CTX), null);
  assert.equal(DC.classify({}, CTX), null);
  assert.equal(DC.classify({ path: 'C:\\x' }, null), null);
});

test('forward slashes normalize like backslashes', () => {
  assert.equal(cat({ path: 'C:/Users/u/AppData/Local/Temp/x.tmp' }), 'temp');
});

// ── POSIX ──────────────────────────────────────────────────────────────────
// Same closed list, different vocabulary. The asymmetry that matters here is
// the mirror of disk-guard.js: this is an ALLOWLIST, so it is safe when it
// UNDER-matches — every extra match is another delete button. Hence the
// case-sensitive comparisons off Windows.
const DG = require('../disk-guard.js');

const MAC_CTX = {
  platform: 'darwin',
  userProfile: '/Users/u',
  tempDirs: ['/var/folders/xy/abc/T'],
  systemDirs: DG.SYSTEM_PREFIXES,
  trashDirs: ['/Users/u/.Trash'],
  devFolders: ['/Users/u/Progetti', '/opt/proj'],
  downloads: '/Users/u/Downloads',
  installerAgeDays: 30,
  now: NOW,
};
const mcat = (entry) => {
  const r = DC.classify({ isDir: false, name: '', ext: '', mtime: NOW, ...entry }, MAC_CTX);
  return r ? r.cat : null;
};

test('macOS: temp classifies through either firmlink spelling', () => {
  assert.equal(mcat({ path: '/var/folders/xy/abc/T/x.tmp' }), 'temp');
  assert.equal(mcat({ path: '/private/var/folders/xy/abc/T/x.tmp' }), 'temp');
});

test('macOS: only known vendors under ~/Library/Caches classify', () => {
  assert.equal(mcat({ path: '/Users/u/Library/Caches/Google/Chrome/Default/Cache/f_1' }), 'browserCache');
  assert.equal(mcat({ path: '/Users/u/Library/Caches/com.apple.Safari/x' }), 'browserCache');
  // An unknown app's cache dir is shown with its size and gets no button.
  assert.equal(mcat({ path: '/Users/u/Library/Caches/com.acme.App/x' }), null);
  // Browser data that is NOT a cache lives outside ~/Library/Caches entirely.
  assert.equal(mcat({ path: '/Users/u/Library/Safari/History.db' }), null);
  assert.equal(mcat({ path: '/Users/u/Library/Application Support/Google/Chrome/Default/Login Data' }), null);
});

test('macOS: package caches classify, secrets next to them do not', () => {
  assert.equal(mcat({ path: '/Users/u/.npm/_cacache/index-v5/x' }), 'pkgCache');
  assert.equal(mcat({ path: '/Users/u/Library/Caches/Homebrew/downloads/x.tar.gz' }), 'pkgCache');
  assert.equal(mcat({ path: '/Users/u/.cargo/registry/cache/x.crate' }), 'pkgCache');
  assert.equal(mcat({ path: '/Users/u/.ssh/id_ed25519' }), null);
  assert.equal(mcat({ path: '/Users/u/.cargo/credentials.toml' }), null);
});

test('macOS: Xcode DerivedData classifies by the child, never the container', () => {
  assert.equal(mcat({ path: '/Users/u/Library/Developer/Xcode/DerivedData/App-abc/Build/x.o' }), 'buildOutput');
  assert.equal(mcat({ path: '/Users/u/Library/Developer/Xcode/DerivedData/App-abc', name: 'App-abc', isDir: true }), 'buildOutput');
  // Xcode recreates the folder but expects to find it; it is a container.
  assert.equal(mcat({ path: '/Users/u/Library/Developer/Xcode/DerivedData', name: 'DerivedData', isDir: true }), null);
  // Device support is NOT a cache: without it you cannot debug a device on an
  // older OS. Shown with its size, no button.
  assert.equal(mcat({ path: '/Users/u/Library/Developer/Xcode/iOS DeviceSupport/17.0/x' }), null);
});

test('macOS: the Trash classifies so the widget can offer "empty"', () => {
  assert.equal(mcat({ path: '/Users/u/.Trash/vecchio.pdf' }), 'recycleBin');
});

test('macOS: build output only under a declared dev folder, and .build counts', () => {
  assert.equal(mcat({ path: '/Users/u/Progetti/app/node_modules', name: 'node_modules', isDir: true }), 'buildOutput');
  assert.equal(mcat({ path: '/Users/u/Progetti/pkg/.build', name: '.build', isDir: true }), 'buildOutput');
  assert.equal(mcat({ path: '/Users/u/Documents/backup/node_modules', name: 'node_modules', isDir: true }), null);
});

test('macOS: a dev folder inside a system root classifies nothing', () => {
  // /opt/proj is a declared dev folder, but disk-guard.js protects /opt — a
  // category that always comes back `protected:system` is worse than no
  // category (the same reason 'winUpdate' was retired on Windows).
  assert.equal(mcat({ path: '/opt/proj/app/node_modules', name: 'node_modules', isDir: true }), null);
  assert.equal(mcat({ path: '/usr/local/lib/node_modules', name: 'node_modules', isDir: true }), null);
});

test('macOS: installers in Downloads only, old only', () => {
  const old = NOW - 60 * DAY, fresh = NOW - 5 * DAY;
  assert.equal(mcat({ path: '/Users/u/Downloads/App.dmg', ext: 'dmg', mtime: old }), 'installers');
  assert.equal(mcat({ path: '/Users/u/Downloads/Tool.pkg', ext: 'pkg', mtime: old }), 'installers');
  assert.equal(mcat({ path: '/Users/u/Downloads/App.dmg', ext: 'dmg', mtime: fresh }), null);
  assert.equal(mcat({ path: '/Users/u/Downloads/foto.jpg', ext: 'jpg', mtime: old }), null);
  assert.equal(mcat({ path: '/Users/u/Documents/App.dmg', ext: 'dmg', mtime: old }), null);
});

test('POSIX: matching is case-SENSITIVE — a miss costs a button, never data', () => {
  assert.equal(mcat({ path: '/Users/u/library/caches/Google/Chrome/x' }), null);
  assert.equal(mcat({ path: '/Users/u/Library/Caches/Google/Chrome/x' }), 'browserCache');
});

const LNX_CTX = {
  platform: 'linux',
  userProfile: '/home/u',
  tempDirs: ['/tmp'],
  systemDirs: DG.SYSTEM_PREFIXES,
  trashDirs: ['/home/u/.local/share/Trash'],
  devFolders: ['/home/u/progetti'],
  downloads: '/home/u/Downloads',
  installerAgeDays: 30,
  now: NOW,
};
const lcat = (entry) => {
  const r = DC.classify({ isDir: false, name: '', ext: '', mtime: NOW, ...entry }, LNX_CTX);
  return r ? r.cat : null;
};

test('Linux: XDG caches, the Trash and distro installers', () => {
  const old = NOW - 60 * DAY;
  assert.equal(lcat({ path: '/tmp/build-1/x.o' }), 'temp');
  assert.equal(lcat({ path: '/home/u/.cache/google-chrome/Default/Cache/x' }), 'browserCache');
  assert.equal(lcat({ path: '/home/u/.cache/pip/http/x' }), 'pkgCache');
  assert.equal(lcat({ path: '/home/u/.local/share/Trash/files/vecchio.txt' }), 'recycleBin');
  assert.equal(lcat({ path: '/home/u/Downloads/app.AppImage', ext: 'AppImage', mtime: old }), 'installers');
  assert.equal(lcat({ path: '/home/u/Downloads/pkg.deb', ext: 'deb', mtime: old }), 'installers');
  // A Windows installer sitting in Downloads is not one of ours to offer here.
  assert.equal(lcat({ path: '/home/u/Downloads/setup.exe', ext: 'exe', mtime: old }), null);
  assert.equal(lcat({ path: '/home/u/.ssh/id_rsa' }), null);
  assert.equal(lcat({ path: '/etc/passwd' }), null);
});
