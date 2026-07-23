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
