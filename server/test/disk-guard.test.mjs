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
