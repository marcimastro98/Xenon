// tools/stage-hunks.mjs: only the hunks whose every changed line matches are staged; a hunk that
// mixes them is named and left out unless asked. The diff here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDiff, pickHunks } from '../../tools/stage-hunks.mjs';

const TOOL = fileURLToPath(new URL('../../tools/stage-hunks.mjs', import.meta.url));

const DIFF = [
  'diff --git a/lang/en.js b/lang/en.js',
  'index 1111111..2222222 100644',
  '--- a/lang/en.js',
  '+++ b/lang/en.js',
  '@@ -10,0 +11,2 @@',
  "+  card_ground: 'Background',",
  "+  card_ground_plain: 'Plain',",
  '@@ -40 +42 @@',
  "-  fans_title: 'Fans',",
  "+  fans_title: 'Your fans',",
  '@@ -90,0 +93,2 @@',
  "+  card_format: 'Format',",
  "+  camera_frames: 'Frames',",
  '@@ -120,0 +125 @@',
  "+  card_size: 'Size',",
  'diff --git a/NOTES.md b/NOTES.md',
  'index 3333333..4444444 100644',
  '--- a/NOTES.md',
  '+++ b/NOTES.md',
  '@@ -2,0 +3 @@',
  '+- fans got quieter',
  '',
].join('\n');

test('a diff splits into files, headers and hunks', () => {
  const files = parseDiff(DIFF);
  assert.deepEqual(files.map((f) => f.name), ['lang/en.js', 'NOTES.md']);
  assert.equal(files[0].header.length, 4);
  assert.deepEqual(files[0].hunks.map((h) => h[0]), ['@@ -10,0 +11,2 @@', '@@ -40 +42 @@', '@@ -90,0 +93,2 @@', '@@ -120,0 +125 @@']);
  assert.equal(files[1].hunks[0].at(-1), '+- fans got quieter', 'no empty line from the final newline');
});

test('only whole matching hunks are staged; mixed ones are named and left out', () => {
  const { patch, kept, mixed } = pickHunks(DIFF, /\bcard_/);
  assert.deepEqual(kept, [{ file: 'lang/en.js', hunks: 2 }]);
  assert.deepEqual(mixed, [{ file: 'lang/en.js', at: '@@ -90,0 +93,2 @@' }]);
  assert.match(patch, /^diff --git a\/lang\/en\.js b\/lang\/en\.js\n/);
  assert.match(patch, /card_ground_plain/);
  for (const other of ['fans_title', 'camera_frames', 'NOTES.md']) assert.ok(!patch.includes(other), other);
  // Numbered again from the kept hunks alone, or git would insert the last one 2 lines too low.
  assert.match(patch, /\n@@ -10,0 \+11,2 @@\n/);
  assert.match(patch, /\n@@ -120,0 \+123 @@\n\+ {2}card_size: 'Size',\n$/);
});

test('--any stages a mixed hunk too; nothing matching gives no patch', () => {
  const { patch, kept } = pickHunks(DIFF, /\bcard_/, { any: true });
  assert.deepEqual(kept, [{ file: 'lang/en.js', hunks: 3 }]);
  assert.match(patch, /camera_frames/);
  assert.match(patch, /\n@@ -120,0 \+125 @@\n/, 'nothing left out before it: the same numbers');
  assert.equal(pickHunks(DIFF, /nothing here/).patch, '');
  assert.equal(pickHunks('', /x/).patch, '');
});

test('in a real repository the index gets the old file plus only the matching lines, each in its place', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stage-hunks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf8' });
  const rows = Array.from({ length: 20 }, (_, i) => `row ${i + 1}`);
  git('init', '-q');
  writeFileSync(join(dir, 'f.txt'), `${rows.join('\n')}\n`);
  git('add', 'f.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'rows');
  const edited = [...rows];
  edited.splice(18, 0, 'card y');
  edited.splice(15, 0, 'other b');
  edited.splice(10, 0, 'card x');
  edited.splice(3, 0, 'other a');
  writeFileSync(join(dir, 'f.txt'), `${edited.join('\n')}\n`);
  execFileSync(process.execPath, [TOOL, '^card ', 'f.txt'], { cwd: dir, encoding: 'utf8' });
  const want = [...rows];
  want.splice(18, 0, 'card y');
  want.splice(10, 0, 'card x');
  assert.equal(git('show', ':f.txt'), `${want.join('\n')}\n`);
});
