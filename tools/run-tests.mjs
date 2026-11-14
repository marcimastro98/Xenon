// Runs the test suite with its own temp folder and removes that folder at the end.
// Many tests make temp files and folders and leave them behind (hundreds of
// thousands piled up in the system Temp over a few months); pointing TEMP, TMP and
// TMPDIR at one folder per run catches them all, whichever test made them.
//
//   node tools/run-tests.mjs <node --test arguments...>      (npm test does this)
//
// XENON_TEST_CONCURRENCY=<n> runs at most n test files at a time, for a PC that
// is busy or short of memory. Without it node chooses (one per processor less one).

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The environment a test run gets: every temp variable aimed at `dir`. */
export function testEnv(env, dir) {
  return { ...env, TEMP: dir, TMP: dir, TMPDIR: dir };
}

/** The `--test-concurrency` argument a run gets from XENON_TEST_CONCURRENCY, or none. */
export function concurrencyArgs(env) {
  const n = Number(env.XENON_TEST_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 && n <= 64 ? [`--test-concurrency=${n}`] : [];
}

function main() {
  const dir = mkdtempSync(path.join(tmpdir(), 'xenon-test-run-'));
  const child = spawn(process.execPath, ['--test', ...concurrencyArgs(process.env), ...process.argv.slice(2)], {
    stdio: 'inherit', env: testEnv(process.env, dir),
  });
  const cleanup = () => {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch (err) {
      console.warn(`[run-tests] could not remove ${dir}: ${err.message}`);
    }
  };
  // Ctrl+C reaches the child through the console; wait for it to end, then clean.
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {});
  child.on('exit', (code, signal) => {
    cleanup();
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
