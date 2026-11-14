// The command `bare`: every `require('x');` of the server code that stands alone on a line, and
// whether taking it out can change anything. The rule is in bare-requires.mjs; this reads the files.
//
//   node tools/restructure/cli.mjs bare [--json] [<file> ...]

import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { judgeBareRequires } from './bare-requires.mjs';

// Tests and other people's code are not the app: their lines are not judged, and what they ask for does not count.
export const OUTSIDE = /^server\/(?:test|vendor)\/|\/node_modules\/|^server\/js\/vendor\//;
const posix = (file) => String(file).split(path.sep).join('/');

/** @param {string} root @returns {string[]} the JavaScript of the server that git tracks, repo-relative */
export function serverFiles(root) {
  const run = spawnSync('git', ['ls-files', '-z', '--', 'server'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`git ls-files failed: ${run.stderr}`);
  return run.stdout.split('\0').filter((file) => file.endsWith('.js') && !OUTSIDE.test(file));
}

/**
 * @param {any} parser from parser.mjs @param {string} root the checkout
 * @param {{ flags: Record<string, any>, rest: string[] }} args files to show (all when none), --json for the rows as data
 * @returns {number} exit code
 */
export function runBare(parser, root, args) {
  const texts = new Map();
  const read = (file) => {
    if (!texts.has(file)) {
      try { texts.set(file, readFileSync(path.join(root, file), 'utf8')); } catch { texts.set(file, null); }
    }
    return texts.get(file);
  };
  // server/shared is a link to packages/core: one file, one name.
  const real = (file) => {
    try { return posix(path.relative(root, realpathSync(path.join(root, file)))); } catch { return file; }
  };
  const { rows, unseen } = judgeBareRequires({ files: serverFiles(root), read, parser, real });
  const wanted = new Set(args.rest.map((file) => real(posix(file))));
  const shown = wanted.size ? rows.filter((row) => wanted.has(row.file)) : rows;
  if (args.flags.json) {
    console.log(JSON.stringify({ rows: shown, unseen }, null, 1));
    return 0;
  }
  for (const row of shown) console.log(`${row.verdict.padEnd(5)}  ${row.file}:${row.line}  require('${row.spec}');\n       ${row.why}`);
  for (const use of unseen) console.log(`not followed: ${use.file}:${use.line} uses require in another way`);
  const dead = shown.filter((row) => row.verdict === 'dead').length;
  console.log(`${shown.length} bare require lines: ${dead} can go, ${shown.length - dead} stay.`);
  return 0;
}
