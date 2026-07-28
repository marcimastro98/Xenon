// Disk deletion hard blocklist (server/disk-guard.js) — the last gate before
// the helper's recycle-bin delete. Every refusal here is a data-loss class
// that must stay closed: the guard wins over a valid category, and a bug
// upstream must degrade to "refused", never to "deleted".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DG = require('../disk-guard.js');

const CTX = DG.buildGuardCtx({
  // Pinned, not inferred — see the same note in disk-categories.test.mjs.
  platform: 'win32',
  windir: 'C:\\Windows',
  programFiles: 'C:\\Program Files',
  programFilesX86: 'C:\\Program Files (x86)',
  documents: 'C:\\Users\\u\\Documents',
  pictures: 'C:\\Users\\u\\Pictures',
  desktop: 'C:\\Users\\u\\Desktop',
  music: 'C:\\Users\\u\\Music',
  videos: 'C:\\Users\\u\\Videos',
  dataDir: 'C:\\Xenon\\server\\data',
  appRoot: 'C:\\Xenon',
  userProfile: 'C:\\Users\\u',
  root: 'C:\\',
});
const ok = { exists: true, isReparse: false };
const guard = (p, flags = ok) => DG.guardDelete(p, CTX, flags);

test('a normal deep temp path passes', () => {
  assert.deepEqual(guard('C:\\Users\\u\\AppData\\Local\\Temp\\x.tmp'), { ok: true });
});

test('every protected prefix refuses, including Xenon itself', () => {
  const cases = [
    ['C:\\Windows\\Temp\\x', 'protected:windir'],
    ['C:\\Program Files\\App\\file.dll', 'protected:programFiles'],
    ['C:\\Program Files (x86)\\App\\file.dll', 'protected:programFilesX86'],
    ['C:\\Users\\u\\Documents\\tesi.docx', 'protected:documents'],
    ['C:\\Users\\u\\Pictures\\img.jpg', 'protected:pictures'],
    ['C:\\Users\\u\\Desktop\\note.txt', 'protected:desktop'],
    ['C:\\Users\\u\\Music\\song.mp3', 'protected:music'],
    ['C:\\Users\\u\\Videos\\clip.mp4', 'protected:videos'],
    ['C:\\Xenon\\server\\data\\settings.json', 'protected:dataDir'],
    ['C:\\Xenon\\node_modules\\koffi\\index.js', 'protected:appRoot'],
  ];
  for (const [p, reason] of cases) {
    const r = guard(p);
    assert.equal(r.ok, false, p);
    assert.equal(r.reason, reason, p);
  }
});

test('reparse points refuse — a junction must never become a delete of its target', () => {
  const r = guard('C:\\Users\\u\\AppData\\Local\\Temp\\link', { exists: true, isReparse: true });
  assert.deepEqual(r, { ok: false, reason: 'reparse' });
});

test('missing files refuse (stale enumeration, not an error to act on)', () => {
  assert.equal(guard('C:\\Users\\u\\AppData\\Local\\Temp\\gone.tmp', { exists: false, isReparse: false }).reason, 'missing');
});

test('paths outside the scanned root refuse', () => {
  const r = guard('D:\\Temp\\x.tmp');
  assert.deepEqual(r, { ok: false, reason: 'off_root' });
});

test('drive roots and first-level directories refuse as too shallow', () => {
  assert.equal(guard('C:\\').reason, 'too_shallow');
  assert.equal(guard('C:\\Temp').reason, 'too_shallow');
  assert.equal(guard('C:\\Users\\u').reason, 'protected:userProfile');
});

test('relative, UNC and traversal paths refuse before anything else', () => {
  assert.equal(guard('Temp\\x.tmp').reason, 'not_absolute');
  assert.equal(guard('\\\\server\\share\\x').reason, 'not_absolute');
  assert.equal(guard('C:\\Users\\u\\AppData\\..\\..\\..\\Windows\\x').reason, 'traversal');
  assert.equal(guard('').reason, 'not_absolute');
  assert.equal(guard(null).reason, 'not_absolute');
});

test('guard without a root context refuses everything', () => {
  const r = DG.guardDelete('C:\\Users\\u\\AppData\\Local\\Temp\\x', null, ok);
  assert.equal(r.ok, false);
});

test('forward slashes normalize — no bypass by separator choice', () => {
  assert.equal(guard('C:/Users/u/Documents/tesi.docx').reason, 'protected:documents');
  assert.deepEqual(guard('C:/Users/u/AppData/Local/Temp/x.tmp'), { ok: true });
});

test('case differences never bypass a protected prefix', () => {
  assert.equal(guard('c:\\users\\U\\DOCUMENTS\\x.docx').reason, 'protected:documents');
});

// ── POSIX ──────────────────────────────────────────────────────────────────
// The guard became cross-platform in v4.11.0. Two asymmetries are pinned here
// because getting either backwards turns a refusal into a deletion:
//   * protection prefixes compare case-INSENSITIVELY (over-match = refuse more)
//   * the root-containment check compares case-SENSITIVELY (over-match would
//     ADMIT an off-root path)

const MAC = DG.buildGuardCtx({
  platform: 'darwin',
  documents: '/Users/u/Documents', pictures: '/Users/u/Pictures',
  desktop: '/Users/u/Desktop', music: '/Users/u/Music', videos: '/Users/u/Movies',
  dataDir: '/Users/u/.xenon/server/data', appRoot: '/Users/u/.xenon',
  userProfile: '/Users/u',
  root: '/',
  tempDirs: ['/var/folders/xy/abc/T'],
});
const mac = (p, flags = ok) => DG.guardDelete(p, MAC, flags);

test('macOS: a cache under the user Library passes', () => {
  assert.deepEqual(mac('/Users/u/Library/Caches/Google/Chrome/Default/Cache/f_1'), { ok: true });
});

test('macOS: the OS-owned roots refuse', () => {
  for (const p of ['/System/Library/CoreServices/x', '/usr/local/bin/node', '/Applications/Safari.app/x',
                   '/Library/Preferences/x', '/etc/hosts', '/var/db/x', '/bin/sh', '/opt/homebrew/bin/x']) {
    assert.equal(mac(p).reason, 'protected:system', p);
  }
});

test('macOS: the personal folders refuse, Movies included', () => {
  assert.equal(mac('/Users/u/Documents/tesi.pages').reason, 'protected:documents');
  assert.equal(mac('/Users/u/Movies/clip.mov').reason, 'protected:videos');
  assert.equal(mac('/Users/u/.xenon/server/data/settings.json').reason, 'protected:dataDir');
});

test('macOS: the temp exemption is strictly BELOW the temp dir, and both spellings fold', () => {
  assert.deepEqual(mac('/var/folders/xy/abc/T/build-1234/x.o'), { ok: true });
  // /private/var and /var are the same directory reached through a firmlink.
  assert.deepEqual(mac('/private/var/folders/xy/abc/T/build-1234/x.o'), { ok: true });
  // The temp directory ITSELF is not exempt: every running process resolves
  // that path from the environment.
  assert.equal(mac('/var/folders/xy/abc/T').reason, 'protected:system');
});

test('macOS: volume roots, home roots and the filesystem root refuse as too shallow', () => {
  assert.equal(mac('/').reason, 'too_shallow');
  assert.equal(mac('/tmp').reason, 'too_shallow');
  assert.equal(mac('/Users').reason, 'too_shallow');
  assert.equal(mac('/Users/u').reason, 'too_shallow');
  assert.equal(mac('/Volumes/Backup').reason, 'too_shallow');
});

test('macOS: another account\'s home refuses whatever the scan root says', () => {
  assert.equal(mac('/Users/altro/Documents/x').reason, 'protected:otherUser');
  assert.equal(mac('/Users/altro/Library/Caches/Google/Chrome/x').reason, 'protected:otherUser');
});

test('macOS: relative paths, tildes and traversal refuse before anything else', () => {
  assert.equal(mac('Users/u/x').reason, 'not_absolute');
  assert.equal(mac('~/Library/Caches/x').reason, 'not_absolute');
  assert.equal(mac('/Users/u/Library/../../../etc/passwd').reason, 'traversal');
});

test('macOS: a backslash is a filename character, never a separator', () => {
  // "Documents\evil" is a single file in the home directory, NOT the Documents
  // folder — rewriting separators the way the Windows path does would conflate
  // two different files.
  assert.deepEqual(mac(String.raw`/Users/u/Documents\evil`), { ok: true });
  // And the guard still sees the real Documents folder for what it is.
  assert.equal(mac('/Users/u/Documents/evil').reason, 'protected:documents');
});

test('macOS: case never bypasses a protected prefix', () => {
  assert.equal(mac('/USERS/U/documents/x').reason, 'protected:documents');
});

test('POSIX: the root check is case-SENSITIVE — the one comparison that admits', () => {
  const vol = DG.buildGuardCtx({ platform: 'darwin', userProfile: '/Users/u', root: '/Volumes/Backup' });
  assert.deepEqual(DG.guardDelete('/Volumes/Backup/cache/x', vol, ok), { ok: true });
  assert.equal(DG.guardDelete('/Volumes/backup/cache/x', vol, ok).reason, 'off_root');
  assert.equal(DG.guardDelete('/Users/u/Library/Caches/x', vol, ok).reason, 'off_root');
});

const LNX = DG.buildGuardCtx({
  platform: 'linux',
  documents: '/home/u/Documents', pictures: '/home/u/Pictures',
  desktop: '/home/u/Desktop', music: '/home/u/Music', videos: '/home/u/Videos',
  dataDir: '/home/u/.xenon/server/data', appRoot: '/home/u/.xenon',
  userProfile: '/home/u', root: '/', tempDirs: ['/tmp'],
});
const lnx = (p, flags = ok) => DG.guardDelete(p, LNX, flags);

test('Linux: XDG caches pass, system roots and other homes refuse', () => {
  assert.deepEqual(lnx('/home/u/.cache/google-chrome/Default/Cache/x'), { ok: true });
  assert.deepEqual(lnx('/tmp/build-1/x.o'), { ok: true });
  assert.equal(lnx('/etc/passwd').reason, 'protected:system');
  assert.equal(lnx('/boot/vmlinuz').reason, 'protected:system');
  assert.equal(lnx('/home/altro/.cache/x').reason, 'protected:otherUser');
  assert.equal(lnx('/home/u/Documents/tesi.odt').reason, 'protected:documents');
});

test('Linux: the localised user directories are protected alongside the English ones', () => {
  // What diskspace.js builds after reading ~/.config/user-dirs.dirs on an
  // Italian desktop. Both spellings refuse, and the reason keeps the English
  // key so nothing downstream has to learn a per-language vocabulary.
  const it = DG.buildGuardCtx({
    platform: 'linux',
    documents: '/home/u/Documents', desktop: '/home/u/Desktop',
    userProfile: '/home/u', root: '/',
    extraProtected: [
      { key: 'documents', path: '/home/u/Documenti' },
      { key: 'desktop', path: '/home/u/Scrivania' },
    ],
  });
  assert.equal(DG.guardDelete('/home/u/Documenti/tesi.odt', it, ok).reason, 'protected:documents');
  assert.equal(DG.guardDelete('/home/u/Scrivania/nota.txt', it, ok).reason, 'protected:desktop');
  assert.equal(DG.guardDelete('/home/u/Documents/tesi.odt', it, ok).reason, 'protected:documents');
  // And nothing else changed: a cache is still cleanable.
  assert.deepEqual(DG.guardDelete('/home/u/.cache/chromium/Cache/x', it, ok), { ok: true });
});
