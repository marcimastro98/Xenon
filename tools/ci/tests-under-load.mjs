#!/usr/bin/env node
// Runs the test suite while this machine is kept busy, to find the tests that only pass
// when nothing else is running: the ones that pause a fixed time and then assert. A shared
// CI runner is such a busy machine, and there they fail one at a time, a push apart.
//
//   node tools/ci/tests-under-load.mjs [--burners <n>] [--minutes <n>] [test files or globs...]
//
// It starts <n> small processes (default: one per processor) that each keep one core busy and
// write and delete a file in a folder of their own, runs the suite the way `npm test` does,
// prints the tests that failed, then stops only the processes it started and removes their
// folder. A test that fails here and passes alone is waiting for a time, not for a result.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUITE = ['server/test/*.test.mjs', 'packages/core/test/*.test.mjs', 'packages/mcp/test/*.test.mjs'];

// One core kept busy, with a file written and removed every few milliseconds of work.
const BURNER = `
const fs = require('node:fs');
const file = require('node:path').join(process.argv[1], 'burn-' + process.pid + '.bin');
const block = Buffer.alloc(256 * 1024, 7);
const turn = () => {
  const until = Date.now() + 40;
  let n = 0;
  while (Date.now() < until) n += Math.sqrt(n + 1);
  try { fs.writeFileSync(file, block); fs.rmSync(file, { force: true }); } catch { /* the folder is going away */ }
  setImmediate(turn);
};
turn();
`;

/**
 * What the command line asks for. Pure, so it is tested.
 * @param {string[]} argv
 * @param {number} cores
 * @returns {{ burners: number, minutes: number, files: string[] }}
 */
export function loadOptions(argv, cores) {
  const files = [];
  let burners = cores;
  let minutes = 25;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--burners') burners = Number(argv[++i]);
    else if (argv[i] === '--minutes') minutes = Number(argv[++i]);
    else files.push(argv[i]);
  }
  if (!Number.isInteger(burners) || burners < 1 || burners > 64) throw new Error('--burners takes a whole number from 1 to 64');
  if (!(minutes > 0 && minutes <= 60)) throw new Error('--minutes takes a number up to 60');
  return { burners, minutes, files: files.length ? files : SUITE };
}

/**
 * The failed tests of a run, from the text the test runner printed. Pure, so it is tested.
 * @param {string} output
 * @returns {string[]} one line per failed test, each once, in the order first seen
 */
export function failedTests(output) {
  const start = output.lastIndexOf('failing tests:');
  if (start < 0) return [];
  const found = [];
  let where = '';
  for (const line of output.slice(start).split('\n')) {
    if (line.startsWith('test at ')) where = line.slice(8).trim();
    else if (line.startsWith('✖ ')) {
      found.push(where ? `${line.slice(2).trim()}  [${where}]` : line.slice(2).trim());
      where = '';
    }
  }
  return [...new Set(found)];
}

function main(argv) {
  const { burners, minutes, files } = loadOptions(argv, availableParallelism());
  const dir = mkdtempSync(path.join(tmpdir(), 'xenon-load-'));
  const started = [];
  for (let i = 0; i < burners; i++) started.push(spawn(process.execPath, ['-e', BURNER, dir], { stdio: 'ignore' }));
  console.log(`${burners} busy processes started; running the tests (limit ${minutes} minutes)`);

  const run = spawn(process.execPath, ['tools/run-tests.mjs', ...files], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  run.stdout.on('data', (chunk) => { output += chunk; });
  run.stderr.on('data', (chunk) => { output += chunk; });
  const limit = setTimeout(() => { console.log(`stopped after ${minutes} minutes`); run.kill(); }, minutes * 60_000);

  run.on('exit', (code) => {
    clearTimeout(limit);
    for (const child of started) child.kill();
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* a burner was mid-write; the system clears temp */ }
    const totals = output.split('\n').filter((line) => /^ℹ (tests|pass|fail|cancelled) /.test(line)).join('  ');
    console.log(totals || 'the run printed no totals');
    const failed = failedTests(output);
    for (const name of failed) console.log(`FAILED UNDER LOAD  ${name}`);
    if (!failed.length && code === 0) console.log('Every test passed with the machine busy.');
    process.exitCode = code === 0 ? 0 : 1;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
