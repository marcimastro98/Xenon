// A busy app beside a real game, so Core Shield can be tried with nothing to set up. It waits for
// the game on the local server, fills half the threads while the game runs and stops with it.
// It only reads the server, and the one app it starts ends by itself at the limit.
//   node tools/perf/shield-proof/game-load.mjs [game name] [--minutes 40] [--hours 4] [--port 3030]
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appCopy, startApp } from './index.mjs';

const require = createRequire(import.meta.url);
const { BUSY_NAME } = require('./host.cjs');

const READ_EVERY_MS = 3000;
const READ_TIMEOUT_MS = 2000;
const LOAD_SHARE = 0.5;
// The app's own limit comes after this tool's, which is the one that normally stops it.
const APP_LIMIT_MARGIN_MS = 15000;
const MINUTE = 60000;

export const loadThreads = (cpus) => Math.max(1, Math.round(cpus * LOAD_SHARE));

export function parseArgs(argv) {
  const options = { game: '', minutes: 40, hours: 4, port: 3030 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = /^--(minutes|hours|port)$/.exec(argv[i]);
    if (flag) options[flag[1]] = Number(argv[(i += 1)]);
    else options.game = argv[i].toLowerCase();
  }
  return options;
}

export function isOurGame(status, wanted) {
  if (!status || status.gameRunning !== true) return false;
  return !wanted || String(status.gameProcess || '').toLowerCase().includes(wanted);
}

// 'start', 'stop' or 'wait'. A server that stops answering reads as no game: the load goes.
export function nextStep(state, { game, now, limitMs }) {
  if (state.loadSince !== null) return !game || now - state.loadSince >= limitMs ? 'stop' : 'wait';
  return game && !state.spent ? 'start' : 'wait';
}

// Only a server that answers "no game" ends the game: a missed read stops the load,
// and must not start it again at the next answer as if a new game had begun.
export function stillSpent({ step, running, answered, spent }) {
  if (step === 'stop') return running || !answered;
  return answered && !running ? false : spent;
}

async function read(port, route) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const say = (text) => console.log(`${new Date().toLocaleTimeString()}  ${text}`);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// A killed child has a signal and no exit code, and says 'exit' only once.
export function stopLoad(load) {
  if (!load || load.exitCode !== null || load.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    load.once('exit', resolve);
    load.kill();
  });
}

async function run({ game, minutes, hours, port }) {
  const limitMs = minutes * MINUTE;
  const until = Date.now() + hours * 60 * MINUTE;
  const threads = loadThreads(os.availableParallelism());
  const folder = mkdtempSync(path.join(os.tmpdir(), 'xenon-game-load-'));
  const state = { loadSince: null, spent: false };
  let load = null;
  let moved = '';
  let quit = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { quit = true; });

  try {
    const exe = appCopy(folder, BUSY_NAME);
    say(`waiting for ${game || 'a game'}, up to ${hours} h`);
    while (!quit && Date.now() < until) {
      const status = await read(port, '/api/gamemode/status');
      const running = isOurGame(status, game);
      const step = nextStep(state, { game: running, now: Date.now(), limitMs });
      if (step === 'start') {
        load = startApp(exe, 'hog.cjs', { HOG_THREADS: String(threads), HOG_LIMIT_MS: String(limitMs + APP_LIMIT_MARGIN_MS) });
        state.loadSince = Date.now();
        moved = '';
        say(`${status.gameProcess}: load on, ${threads} threads`);
      } else if (step === 'stop') {
        await stopLoad(load);
        say(`load off after ${Math.round((Date.now() - state.loadSince) / 1000)} s, moved: ${moved || 'nothing'}`);
        state.loadSince = null;
      }
      state.spent = stillSpent({ step, running, answered: status !== null, spent: state.spent });
      if (state.loadSince !== null) {
        const shield = await read(port, '/api/performance/shield');
        const now = JSON.stringify(shield && shield.moved ? shield.moved : []);
        if (now !== '[]' && now !== moved) {
          moved = now;
          say(`moved after ${Math.round((Date.now() - state.loadSince) / 1000)} s: ${now}`);
        }
      }
      await sleep(READ_EVERY_MS);
    }
  } finally {
    await stopLoad(load);
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  say('done');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run(parseArgs(process.argv.slice(2)));
}
