// Type-checks the engine code as it is written (plain JS with JSDoc, no build)
// and compares the result with the saved numbers: a file may lose errors, never gain them.
//
//   npm run typecheck             check
//   npm run typecheck -- --update save the lower numbers after a clean-up
//   npm run typecheck -- --rebase save whatever today's numbers are (new TypeScript, new scope)

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCounts, saveCounts, sum } from './baseline-file.mjs';
import { compareCounts } from './ratchet.mjs';
import { REPO_ROOT } from './repo-files.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TSC = path.join(HERE, 'node_modules', 'typescript', 'bin', 'tsc');
const PROJECT = path.join(HERE, 'tsconfig.server.json');
const BASELINE = path.join(HERE, 'baseline', 'types-server.json');
const NOTE = 'Type errors per "file code". Written by tools/quality/typecheck.mjs: numbers only go down.';
const ERROR_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): /;

/**
 * Turns the compiler's text into one number per "file · error code".
 * @param {string} text compiler output, one finding per line
 * @param {string} cwd the folder the compiler ran in (its paths are relative to it)
 * @param {string} root the repo root
 * @returns {Record<string, number>}
 */
export function countTypeErrors(text, cwd, root) {
  const counts = {};
  for (const line of text.split(/\r?\n/)) {
    const found = ERROR_LINE.exec(line);
    if (!found) continue;
    const file = path.relative(root, path.resolve(cwd, found[1])).split(path.sep).join('/');
    const key = `${file} ${found[4]}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function runCompiler() {
  const run = spawnSync(process.execPath, [TSC, '-p', PROJECT, '--pretty', 'false'], {
    cwd: HERE, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  return `${run.stdout}\n${run.stderr}`;
}

function printList(title, rows) {
  if (rows.length === 0) return;
  console.log(`\n${title}`);
  for (const row of rows) console.log(`  ${row.key}: ${row.was} -> ${row.now}`);
}

function main(args) {
  if (!existsSync(TSC)) {
    console.error('TypeScript is not installed here. Run: npm run quality:install');
    return 1;
  }
  const text = runCompiler();
  const counts = countTypeErrors(text, HERE, REPO_ROOT);
  if (Object.keys(counts).length === 0 && /error TS\d+/.test(text)) {
    console.error(text.trim());
    return 1;
  }
  if (args.includes('--rebase')) {
    console.log(`Saved: ${saveCounts(BASELINE, NOTE, counts)} type errors are the new starting point.`);
    return 0;
  }
  const { worse, better } = compareCounts(readCounts(BASELINE), counts);
  printList('New type errors (fix them, the list below names file and error code):', worse);
  if (worse.length > 0) {
    const wanted = new Set(worse.map((row) => row.key));
    for (const line of text.split(/\r?\n/)) {
      const found = ERROR_LINE.exec(line);
      if (!found) continue;
      const file = path.relative(REPO_ROOT, path.resolve(HERE, found[1])).split(path.sep).join('/');
      if (wanted.has(`${file} ${found[4]}`)) console.log(`  ${file}(${found[2]},${found[3]}): ${line.slice(found[0].length - found[4].length - 2)}`);
    }
    return 1;
  }
  if (args.includes('--update')) {
    console.log(`Saved: ${saveCounts(BASELINE, NOTE, counts)} type errors left.`);
    return 0;
  }
  console.log(`Types: no new errors (${sum(counts)} old ones left).`);
  if (better.length > 0) console.log(`${better.length} entries got better. Save them with: npm run typecheck -- --update`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
