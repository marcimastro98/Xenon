import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const F = require('../slideshow-folder.js');

// Build a throwaway folder with a known set of files. The module reads the real
// filesystem, so the tests do too — the whole point of this module is what readdir
// gives back, and a mock would only assert the mock.
function makeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-slideshow-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body || 'x');
  return dir;
}

test('listFolder: counts only allow-listed image types', async () => {
  const dir = makeDir({
    'a.gif': '', 'b.PNG': '', 'c.jpeg': '', 'd.webp': '',
    'notes.txt': '', 'clip.mp4': '', 'script.exe': '', 'noext': '',
  });
  const out = await F.listFolder(dir, { refresh: true });
  assert.equal(out.ok, true);
  assert.equal(out.count, 4);           // the four images, nothing else
  assert.equal(out.error, null);
});

test('listFolder: subfolders are not descended into', async () => {
  const dir = makeDir({ 'top.gif': '' });
  const sub = path.join(dir, 'nested');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'deep.gif'), 'x');
  const out = await F.listFolder(dir, { refresh: true });
  assert.equal(out.count, 1);           // top.gif only — "one folder" means one folder
});

test('listFolder: a relative path is refused outright', async () => {
  const out = await F.listFolder('pictures/gifs', { refresh: true });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'no_folder');
});

test('listFolder: a missing folder and a file-not-folder are distinguished', async () => {
  const missing = await F.listFolder(path.join(os.tmpdir(), 'xenon-does-not-exist-' + Date.now()), { refresh: true });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'not_found');

  const dir = makeDir({ 'a.gif': '' });
  const asFile = await F.listFolder(path.join(dir, 'a.gif'), { refresh: true });
  assert.equal(asFile.ok, false);
  // Windows reports ENOENT where POSIX reports ENOTDIR; both mean "not a folder".
  assert.ok(['not_a_dir', 'not_found'].includes(asFile.error), 'got ' + asFile.error);
});

test('listFolder: an empty folder is a success with zero images, not an error', async () => {
  const out = await F.listFolder(makeDir({}), { refresh: true });
  assert.equal(out.ok, true);
  assert.equal(out.count, 0);
  assert.equal(out.error, null);
});

test('resolveFile: index maps to a file inside the folder, in natural order', async () => {
  const dir = makeDir({ 'img2.gif': '', 'img10.gif': '', 'img1.gif': '' });
  await F.listFolder(dir, { refresh: true });
  const first = await F.resolveFile(dir, 0);
  const second = await F.resolveFile(dir, 1);
  const third = await F.resolveFile(dir, 2);
  assert.equal(first.name, 'img1.gif');
  assert.equal(second.name, 'img2.gif');
  assert.equal(third.name, 'img10.gif');    // natural order, not 'img10' before 'img2'
  assert.equal(first.mime, 'image/gif');
  assert.equal(path.dirname(first.abs), path.resolve(dir));
});

test('resolveFile: out-of-range and malformed indexes resolve to nothing', async () => {
  const dir = makeDir({ 'a.gif': '' });
  await F.listFolder(dir, { refresh: true });
  for (const i of [1, 99, -1, 1.5, 'abc', '', null, undefined, '../../etc/passwd']) {
    assert.equal(await F.resolveFile(dir, i), null, 'index ' + JSON.stringify(i));
  }
  assert.ok(await F.resolveFile(dir, 0));         // the valid one still works
  assert.ok(await F.resolveFile(dir, '0'));       // a numeric string is the wire format
});

test('resolveFile: a relative folder resolves to nothing', async () => {
  assert.equal(await F.resolveFile('pictures', 0), null);
  assert.equal(await F.resolveFile('', 0), null);
});

test('MAX_BYTES matches the cap the upload path enforces', () => {
  // The folder source must not be a way around the per-image ceiling the uploader
  // applies; server.js refuses a larger file with 413 at serve time.
  assert.equal(F.MAX_BYTES, 20 * 1024 * 1024);
});

test('invalidate: a folder re-read picks up files added since', async () => {
  const dir = makeDir({ 'a.gif': '' });
  assert.equal((await F.listFolder(dir, { refresh: true })).count, 1);
  fs.writeFileSync(path.join(dir, 'b.gif'), 'x');
  // Still 1 from the cache — the TTL has not elapsed.
  assert.equal((await F.listFolder(dir)).count, 1);
  F.invalidate();
  assert.equal((await F.listFolder(dir)).count, 2);
});
