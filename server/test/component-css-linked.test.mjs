// Every stylesheet under server/components is loaded by a page (<link href>) or
// a script that adds it: one nobody loads is dead code that still looks alive.
// Stylesheets do not count as loaders: none uses @import, and the paths they
// name sit in comments.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listRepoFiles } from '../../tools/repo-sweep/files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function inGitCheckout() {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Through git, so server/data and the other ignored folders are never read.
test('every component stylesheet is loaded somewhere', { skip: !inGitCheckout() && 'needs a git checkout' }, () => {
  const files = listRepoFiles(ROOT).filter((rel) => rel.startsWith('server/') && !rel.startsWith('server/test/'));
  const sheets = files.filter((rel) => rel.startsWith('server/components/') && rel.endsWith('.css'));
  const loaders = files.filter((rel) => /\.(?:html?|[cm]?js)$/.test(rel)).map((rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  assert.ok(sheets.length > 50, `only ${sheets.length} component stylesheets found`);
  const unloaded = sheets.filter((rel) => !loaders.some((text) => text.includes(rel.slice('server/'.length))));
  assert.deepEqual(unloaded, []);
});
