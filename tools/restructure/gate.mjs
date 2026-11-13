#!/usr/bin/env node
// Runs every check a restructure commit has to pass, in order, and stops at the first
// that fails: the moves redone from a base commit, the saved type and lint numbers
// carried along, the map, the sizes, types, lint, the tests, a real start of the
// server, real requests against a throwaway copy, every plain GET route asked before and
// after (the base commit against the working folder), the personal-data sweep, whitespace.
//
//   node tools/restructure/gate.mjs [--base <commit>] [--from <step>] [--only <step>]
//
// XENON_GATE_PORT picks the port of the throwaway servers (default 3039), so two checkouts can
// run their gate at once. 3030 is the installed app's and is refused.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DAILY_PORT = '3030';

/**
 * @param {string | undefined} asked the value of XENON_GATE_PORT
 * @returns {string} the port the throwaway servers listen on
 */
export function gatePort(asked) {
  const port = String(asked || '3039').trim();
  if (!/^\d{4,5}$/.test(port) || port === DAILY_PORT) throw new Error(`XENON_GATE_PORT ${port}: pick a free port that is not ${DAILY_PORT}, the installed app's`);
  return port;
}

const PORT = gatePort(process.env.XENON_GATE_PORT);
const MINUTE = 60_000;

/**
 * The checks, in the order they run. `npm` names the script of the root package.json a step stands for,
 * so a test can hold the two together. Pure, so it is tested.
 * @param {string} base the commit `verify` redoes the moves from
 * @returns {{ name: string, argv: string[], minutes: number, npm?: string, env?: Record<string, string>, git?: boolean }[]}
 */
export function gateSteps(base = 'HEAD') {
  return [
    { name: 'verify', argv: ['tools/restructure/cli.mjs', 'verify', '--base', base], minutes: 10 },
    { name: 'carry', argv: ['tools/restructure/cli.mjs', 'carry'], minutes: 10 },
    { name: 'map', argv: ['tools/map/map.mjs'], minutes: 2, npm: 'map' },
    { name: 'sizes', argv: ['tools/quality/sizes.mjs', '--update'], minutes: 2, npm: 'sizes' },
    { name: 'typecheck', argv: ['tools/quality/typecheck.mjs'], minutes: 10, npm: 'typecheck' },
    { name: 'lint', argv: ['tools/quality/lint.mjs'], minutes: 10, npm: 'lint' },
    { name: 'test', argv: ['tools/run-tests.mjs', 'server/test/*.test.mjs', 'packages/core/test/*.test.mjs', 'packages/mcp/test/*.test.mjs'],
      minutes: 15, npm: 'test' },
    { name: 'boot', argv: ['tools/ci/boot-check.mjs'], minutes: 2, env: { XENON_PORT: PORT } },
    { name: 'requests', argv: ['tools/ci/request-check.mjs'], minutes: 4, env: { XENON_PORT: PORT } },
    { name: 'routes', argv: ['tools/restructure/routes-check.mjs', 'check', '--base', base], minutes: 4, env: { XENON_PORT: PORT } },
    { name: 'personal', argv: ['tools/repo-sweep.mjs', 'personal'], minutes: 5 },
    { name: 'whitespace', argv: ['diff', '--check'], minutes: 1, git: true },
  ];
}

function run(step) {
  const started = Date.now();
  const done = spawnSync(step.git ? 'git' : process.execPath, step.argv, {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...step.env }, timeout: step.minutes * MINUTE, maxBuffer: 512 * 1024 * 1024,
  });
  const output = `${done.stdout ?? ''}${done.stderr ?? ''}`.trimEnd();
  const tail = output.split('\n').slice(step.name === 'test' ? -12 : -6).join('\n');
  const ok = done.status === 0 && !done.error;
  const why = done.error ? ` (${done.error.code === 'ETIMEDOUT' ? `stopped after ${step.minutes} minutes` : done.error.message})` : '';
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${step.name.padEnd(10)} ${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s${why}`);
  if (tail) console.log(tail.split('\n').map((line) => `       ${line}`).join('\n'));
  if (!ok && output) console.log(`--- ${step.name}, last lines ---\n${output.split('\n').slice(-60).join('\n')}`);
  return ok;
}

function main(argv) {
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  let steps = gateSteps(value('--base') ?? 'HEAD');
  const names = steps.map((step) => step.name);
  for (const flag of ['--from', '--only']) {
    if (value(flag) !== undefined && !names.includes(value(flag))) { console.error(`${flag} takes one of: ${names.join(', ')}`); return 2; }
  }
  if (value('--only')) steps = steps.filter((step) => step.name === value('--only'));
  if (value('--from')) steps = steps.slice(names.indexOf(value('--from')));
  for (const step of steps) if (!run(step)) return 1;
  console.log(`All ${steps.length} checks passed.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
