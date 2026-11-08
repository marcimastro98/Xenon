#!/usr/bin/env node
// Core Shield on this machine, for real: a stand-in game beside a busy app, the real
// process table, fence and ledger, frames measured before and after, then the two ways
// back: the end of the session, and a start after a hard kill. Exit code 1 on a failure.
// The shield sees only the apps this tool starts (host.cjs). The figures come from a
// stand-in, not from a game. Windows and Linux; it fills every core for about a minute.
//   node tools/perf/shield-proof/index.mjs [seconds per measure]
//   node tools/perf/shield-proof/index.mjs --linux [seconds per measure]    (needs Docker)
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInContainer } from '../../linux-suite.mjs';

const require = createRequire(import.meta.url);
const { BUSY_NAME, GAME_NAME } = require('./host.cjs');
const { realState, sameState } = require('./real-state.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PATHS = ['server', 'packages', 'apps', 'tools/link-shared.mjs', 'tools/linux-suite.mjs', 'tools/perf/shield-proof', 'package.json', 'package-lock.json'];
const DEFAULT_SECONDS = 10;
const MOVE_LIMIT_MS = 30000;
const BACK_LIMIT_MS = 12000;
const APP_LIMIT_MS = 180000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, limitMs, stepMs = 50) {
  const start = Date.now();
  while (Date.now() - start < limitMs) {
    if (check()) return Date.now() - start;
    await sleep(stepMs);
  }
  return null;
}

export function appCopy(folder, name) {
  const to = path.join(folder, process.platform === 'win32' ? `${name}.exe` : name);
  copyFileSync(process.execPath, to);
  return to;
}

function withLines(child) {
  child.lines = [];
  let rest = '';
  child.stdout.on('data', (chunk) => {
    rest += chunk;
    const parts = rest.split('\n');
    rest = parts.pop();
    child.lines.push(...parts.map((line) => JSON.parse(line)));
  });
  return child;
}

const startHost = (folder, game, busy) => withLines(spawn(process.execPath, [path.join(HERE, 'host.cjs'), folder, game.pid, busy.pid], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true }));

export function startApp(exe, script, env) {
  return spawn(exe, [path.join(HERE, script)], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env, ...env } });
}

async function measure(game, seconds) {
  game.stdin.write('mark\n');
  await sleep(seconds * 1000);
  const seen = game.lines.length;
  game.stdin.write('report\n');
  await waitFor(() => game.lines.length > seen, 3000);
  return game.lines.at(-1);
}

// A frame that misses its budget, in percent; `late` comes as a fraction.
export const framesLine = (f) => `p50 ${f.p50.toFixed(2)} ms, p99 ${f.p99.toFixed(2)} ms, p99.9 ${f.p999.toFixed(2)} ms, late ${(f.late * 100).toFixed(2)} %, ${f.n} frames`;
// Half the late frames at least: the shield either clears the way or it does not.
export const shieldHelped = (busy, shielded) => shielded.late < busy.late / 2;
const lastMoved = (host) => [...host.lines].reverse().find((line) => line.moved)?.moved ?? [];

function createChecks() {
  const failed = [];
  return {
    failed,
    check(ok, what) {
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
      if (!ok) failed.push(what);
    },
  };
}

async function shieldRounds({ game, busy, folder, seconds, check }, firstHost) {
  let host = firstHost;
  const ledger = path.join(folder, 'core-shield.json');
  const before = { game: realState(game.pid), busy: realState(busy.pid) };
  const moved = () => !sameState(realState(busy.pid), before.busy);

  const busyFrames = await measure(game, seconds);
  console.log(`busy, no session: ${framesLine(busyFrames)}`);

  host.stdin.write('on\n');
  const movedAfter = await waitFor(moved, MOVE_LIMIT_MS);
  check(movedAfter !== null, `the busy app moved after ${movedAfter} ms: ${JSON.stringify(realState(busy.pid))}`);
  await waitFor(() => lastMoved(host).length > 0, 4000);
  check(lastMoved(host).length === 1, `one app on the list: ${lastMoved(host).join()}`);
  check(sameState(realState(game.pid), before.game), 'the game was not touched');
  const shieldFrames = await measure(game, seconds);
  console.log(`busy, shield:     ${framesLine(shieldFrames)}`);
  check(shieldHelped(busyFrames, shieldFrames), 'late frames at least halved');

  host.stdin.write('off\n');
  const backAfter = await waitFor(() => !moved(), BACK_LIMIT_MS);
  check(backAfter !== null, `back at the end of the session after ${backAfter} ms`);
  await waitFor(() => !existsSync(ledger), 1000);
  check(!existsSync(ledger), 'no record left after the session');

  host.stdin.write('on\n');
  check(await waitFor(moved, MOVE_LIMIT_MS) !== null, 'moved again, for the hard kill');
  await waitFor(() => existsSync(ledger), 1000);
  host.kill('SIGKILL');
  await sleep(500);
  check(moved() && existsSync(ledger), 'a hard kill leaves it moved, with the record on disk');

  const started = Date.now();
  host = startHost(folder, game, busy);
  const healed = await waitFor(() => !moved(), BACK_LIMIT_MS);
  check(healed !== null, `back ${Date.now() - started} ms after the next start`);
  await waitFor(() => !existsSync(ledger), 1000);
  check(!existsSync(ledger), 'no record left after the recovery');
  return host;
}

async function main(seconds) {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'xenon-shield-proof-'));
  const { check, failed } = createChecks();
  const limit = { GAME_LIMIT_MS: String(APP_LIMIT_MS), HOG_LIMIT_MS: String(APP_LIMIT_MS) };
  const game = withLines(startApp(appCopy(folder, GAME_NAME), 'game.cjs', limit));
  let busy = null;
  let host = null;
  try {
    await waitFor(() => game.lines.length > 0, 8000);
    console.log(`empty machine:    ${framesLine(await measure(game, seconds))}`);
    busy = startApp(appCopy(folder, BUSY_NAME), 'hog.cjs', { ...limit, HOG_THREADS: String(os.availableParallelism()) });
    host = startHost(folder, game, busy);
    await sleep(1500);
    host = await shieldRounds({ game, busy, folder, seconds, check }, host);
  } finally {
    for (const child of [host, game, busy]) child?.kill('SIGKILL');
    await sleep(500);
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  console.log(failed.length ? `${failed.length} failed` : 'all good');
  process.exitCode = failed.length ? 1 : 0;
}

export function containerScript(seconds) {
  const run = `node tools/perf/shield-proof/index.mjs ${seconds}`;
  return [
    'set -e',
    'mkdir -p /tmp/w && cd /tmp/w && tar xf -',
    'chown -R node:node /tmp/w',
    `su node -c "cd /tmp/w && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error --omit=dev && node tools/link-shared.mjs && ${run}"`,
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const linux = process.argv[2] === '--linux';
  const seconds = Number(process.argv[linux ? 3 : 2]) || DEFAULT_SECONDS;
  if (linux) runInContainer(containerScript(seconds), PATHS);
  else await main(seconds);
}
