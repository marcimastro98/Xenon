// Frozen paths: files that installed copies, the old updater, the operating
// system or a user's config call by their exact path. A move or a rename of one
// breaks something that only shows on a user's PC, so this fails first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { globToRegExp } from '../../tools/map/map.mjs';
import { REPO_ROOT, trackedFiles } from '../../tools/quality/repo-files.mjs';

const FROZEN = JSON.parse(readFileSync(path.join(REPO_ROOT, 'tools', 'map', 'frozen-paths.json'), 'utf8'));

test('the frozen list is sorted, without repeats, and names real patterns', () => {
  assert.deepEqual(FROZEN.paths, [...new Set(FROZEN.paths)].sort());
  assert.ok(FROZEN.paths.length > 60, 'the list lost entries');
  assert.ok(FROZEN.whole.length > 0);
});

test('every frozen file is still at its path', (t) => {
  const files = trackedFiles();
  if (!files) return t.skip('no git in this copy of the tree');
  const present = new Set(files);
  const gone = FROZEN.paths.filter((file) => !present.has(file));
  assert.deepEqual(gone, [], 'these files were moved, renamed or deleted: put them back (tools/map/frozen-paths.json says why)');
});

test('a new page or script in a frozen folder is added to the list on purpose', (t) => {
  const files = trackedFiles();
  if (!files) return t.skip('no git in this copy of the tree');
  const listed = new Set(FROZEN.paths);
  const rules = FROZEN.whole.map((glob) => globToRegExp(glob));
  const unlisted = files.filter((file) => rules.some((rule) => rule.test(file)) && !listed.has(file));
  assert.deepEqual(unlisted, [], 'add these to "paths" in tools/map/frozen-paths.json: once released, their path can never change');
});
