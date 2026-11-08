// The Pages workflow redeploys the site only when a path in its push `paths`
// filter changes. The builders it runs before the upload import other tools/
// modules (home-bake, page-meta, trial-covers...), and a change to one of those
// published nothing until some unrelated commit touched docs/. Every module the
// builders load must be named by the filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/pages.yml'), 'utf8').replace(/\r\n/g, '\n');

// The patterns under on.push.paths, comments skipped.
function pathFilter(yml) {
  const block = /\n {4}paths:\n((?: {6}.*\n)+)/.exec(yml);
  assert.ok(block, 'no paths filter under on.push');
  return [...block[1].matchAll(/^ {6}- '([^']+)'$/gm)].map((m) => m[1]);
}

// The scripts the job runs to build docs/, before the artifact is uploaded.
function builders(yml) {
  const build = yml.slice(0, yml.indexOf('upload-pages-artifact'));
  return [...build.matchAll(/run: node (tools\/[\w.-]+\.mjs)/g)].map((m) => m[1]);
}

const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;

// Every repo file reached from the builders through relative imports.
function importClosure(entries) {
  const seen = new Set();
  const visit = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(RELATIVE_IMPORT)) {
      visit(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
    }
  };
  entries.forEach(visit);
  return [...seen];
}

function globMatch(pattern, file) {
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*');
  return new RegExp('^' + re + '$').test(file);
}

test('the deploy builders are found in the workflow', () => {
  const run = builders(WORKFLOW);
  for (const name of ['tools/build-i18n.mjs', 'tools/build-page-langs.mjs', 'tools/build-seo.mjs']) assert.ok(run.includes(name), name);
});

test('every module the deploy builders import is in the push paths filter', () => {
  const filter = pathFilter(WORKFLOW);
  const missing = importClosure(builders(WORKFLOW)).filter((f) => !filter.some((p) => globMatch(p, f)));
  assert.deepEqual(missing, []);
});
