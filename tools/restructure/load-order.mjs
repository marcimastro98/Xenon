// Shows that a step loads every file of the engine in the order it always loaded. Two throwaway copies are
// started, the engine of a commit and the engine of the working folder, each offline and unable to start a program
// (routes-quiet.cjs), each writing down the files it loads (load-order-log.cjs). The two lists are compared, file by
// file, up to the moment the engine file has loaded.
//
//   node tools/restructure/load-order.mjs --base <commit>          XENON_PORT picks the port, never the installed app's

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { request, rigPort, stopChild } from '../ci/engine-rig.mjs';
import { copyEngine } from '../ci/request-check.mjs';
import { copyOfCommit } from './routes-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { DONE } = createRequire(import.meta.url)('./load-order-log.cjs');
const START_LIMIT_MS = 45_000;

/**
 * @param {string} log what load-order-log.cjs wrote
 * @returns {string[] | null} the files loaded before the engine file had loaded, in order; null when it never finished
 */
export function loadedBefore(log) {
  const lines = log.split('\n').filter(Boolean);
  const end = lines.indexOf(DONE);
  return end < 0 ? null : lines.slice(0, end);
}

/**
 * @param {string[]} before @param {string[]} after
 * @returns {string[]} what differs, one sentence each: the first place the two orders part, and files only one has
 */
export function orderProblems(before, after) {
  const problems = [];
  const [had, has] = [new Set(before), new Set(after)];
  const gone = before.filter((file) => !has.has(file));
  const added = after.filter((file) => !had.has(file));
  if (gone.length) problems.push(`no longer loaded while the engine starts: ${gone.slice(0, 8).join(', ')}`);
  if (added.length) problems.push(`newly loaded while the engine starts: ${added.slice(0, 8).join(', ')}`);
  const [a, b] = [before.filter((file) => has.has(file)), after.filter((file) => had.has(file))];
  const at = a.findIndex((file, index) => file !== b[index]);
  if (at >= 0) problems.push(`the order parts at place ${at + 1}: ${a[at]} was loaded there, now ${b[at]} is`, `  before: ${a.slice(at, at + 6).join(', ')}`, `  now:    ${b.slice(at, at + 6).join(', ')}`);
  return problems;
}

// One start of one copy, stopped as soon as it answers; gives back what it wrote down.
async function orderOf(folder, port) {
  const home = path.join(folder, 'home');
  const temp = path.join(folder, 'temp');
  for (const made of [home, temp]) mkdirSync(made, { recursive: true });
  const out = path.join(temp, 'load-order.txt');
  const child = spawn(process.execPath, ['--require', path.join(HERE, 'routes-quiet.cjs'), '--require', path.join(HERE, 'load-order-log.cjs'), 'server/server.js'], {
    cwd: folder, stdio: 'ignore',
    env: { ...process.env, XENON_PORT: String(port), XENON_BIND_HOST: '127.0.0.1', XENON_LOAD_ORDER: out, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: temp, TMP: temp, TMPDIR: temp },
  });
  const limit = setTimeout(() => child.kill(), START_LIMIT_MS);
  try {
    let up = false;
    while (!up && child.exitCode === null) {
      up = Boolean(await request(port, { path: '/version' }));
      if (!up) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!up) throw new Error('the copy of the engine did not start');
  } finally {
    clearTimeout(limit);
    await stopChild(child);
  }
  return existsSync(out) ? readFileSync(out, 'utf8') : '';
}

async function main() {
  const args = process.argv.slice(2);
  const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : null;
  if (!base) { console.log('usage: load-order.mjs --base <commit>'); process.exitCode = 2; return; }
  const port = rigPort(process.env.XENON_PORT);
  const logs = [];
  for (const rev of [base, null]) {
    const folder = rev ? copyOfCommit(rev) : copyEngine();
    try {
      logs.push(await orderOf(folder, port));
    } finally {
      rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
  const [before, after] = logs.map((log) => loadedBefore(log));
  if (!before || !after) { console.log('one of the two engines never finished loading: nothing was compared'); process.exitCode = 1; return; }
  const problems = orderProblems(before, after);
  console.log(problems.length ? problems.join('\n')
    : `the engine loads its ${after.length} files in the same order as at ${base}`);
  process.exitCode = problems.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
