// Every file the engine loads by a relative path exists and ships.
// A `require` inside a function is only reached when that function runs, so a
// moved or misspelt file would pass the start-up check and fail later, on a
// user's PC. This reads the paths instead of waiting for them to run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, trackedFiles } from '../../tools/quality/repo-files.mjs';

const ENGINE = /^(server\/[^/]+\.js|server\/(?!js\/|components\/|vendor\/|public\/|assets\/|sdk-example\/|test\/|styles\/)[^/]+\/.+\.js|packages\/(core|mcp)\/(src|bin)\/.+\.js|tools\/.+\.(mjs|cjs|js))$/;
const LOADS = /(?:\brequire\(|\bimport\(|\bfrom\s+|^\s*import\s+)\s*(['"])(\.{1,2}\/[^'"\n]+)\1/gm;
const ENDINGS = ['', '.js', '.json', '.mjs', '.cjs', '/index.js'];

// Paths that are meant to be missing from the repo: downloaded or built on the
// user's PC, and loaded inside a try/catch that handles their absence.
const OPTIONAL = new Set([]);

function resolveLoad(fromFile, spec) {
  const base = path.resolve(REPO_ROOT, path.dirname(fromFile), spec);
  for (const ending of ENDINGS) {
    const full = base + ending;
    if (existsSync(full) && statSync(full).isFile()) return full;
  }
  return null;
}

function repoPath(full) {
  // server/shared is a link to packages/core, made on install.
  return path.relative(REPO_ROOT, full).split(path.sep).join('/').replace(/^server\/shared\//, 'packages/core/');
}

/** The code with comments blanked out, so an example in a comment is not read as a load. */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/^\s*\/\/.*$/gm, '');
}

test('every relative require and import in the engine points at a tracked file', (t) => {
  const files = trackedFiles();
  if (!files) return t.skip('no git in this copy of the tree');
  if (!existsSync(path.join(REPO_ROOT, 'server', 'shared'))) return t.skip('server/shared is not linked (npm install)');
  const tracked = new Set(files);
  const problems = [];
  let checked = 0;
  for (const file of files.filter((f) => ENGINE.test(f))) {
    const code = withoutComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    for (const match of code.matchAll(LOADS)) {
      const spec = match[2];
      if (OPTIONAL.has(`${file} -> ${spec}`)) continue;
      checked += 1;
      const full = resolveLoad(file, spec);
      if (!full) problems.push(`${file} -> ${spec} (no such file)`);
      else if (!tracked.has(repoPath(full))) problems.push(`${file} -> ${spec} (exists here, but git does not track it: it will be missing from an install)`);
    }
  }
  assert.ok(checked > 1000, `only ${checked} loads found: the pattern no longer matches the code`);
  assert.deepEqual(problems, []);
});
