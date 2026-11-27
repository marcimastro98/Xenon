#!/usr/bin/env node
// A commit of uncommitted work, for dev-install --ref, that moves no branch and leaves the
// real index alone: a base ref (HEAD by default) plus the working tree's changed and
// untracked files, minus the paths given to --skip (a folder skips all it holds). It is
// built in a throwaway index (GIT_INDEX_FILE), so what two sessions have half done in the
// same checkout can be installed apart: each skips the other's files.
//
//   node tools/dev-install/snapshot.mjs [--base <ref>] [--skip <path>]... [--dry-run]
//   then: node tools/dev-install/cli.mjs --ref <the printed sha>
//
// The commit is a loose object no branch points at: git gc drops it in a few weeks.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSnapshotArgs, pickPaths } from './snapshot-lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const USAGE = 'usage: node tools/dev-install/snapshot.mjs [--base <ref>] [--skip <path>]... [--dry-run]';

const git = (args, env) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 1 << 28 });
const lines = (text) => text.split('\0').filter(Boolean);

function main() {
  const args = parseSnapshotArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return 0; }
  if (args.error) { console.error(args.error + '\n' + USAGE); return 2; }

  const base = git(['rev-parse', '--verify', args.base + '^{commit}']).trim();
  // Against the base, so a file changed in the working tree since an older base comes along too.
  const changed = lines(git(['diff', '--name-only', '-z', base]));
  const untracked = lines(git(['ls-files', '--others', '--exclude-standard', '-z']));
  const { take, skipped } = pickPaths(changed, untracked, args.skip);
  console.log(`base ${base.slice(0, 10)}: ${take.length} files from the working tree, ${skipped.length} skipped`);
  for (const file of skipped) console.log('  skip ' + file);
  if (args.dryRun) { for (const file of take) console.log('  take ' + file); return 0; }
  if (!take.length) { console.error('nothing to take: install the base itself'); return 1; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-snapshot-'));
  const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
  try {
    git(['read-tree', base], env);
    // --all: a file deleted in the working tree leaves the snapshot too.
    git(['add', '--all', '--', ...take], env);
    const tree = git(['write-tree'], env).trim();
    const commit = git(['commit-tree', tree, '-p', base, '-m', `dev snapshot of ${base.slice(0, 10)} + ${take.length} working files`]).trim();
    console.log(commit);
    return 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

process.exitCode = main();
