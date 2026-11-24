// libuv's shared pool sized before its first use (server/engine/thread-pool.js): four
// antivirus-held file opens filled the default pool of four and every file call in the engine
// waited behind them, fan commands included (23 Nov 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, '..', 'engine', 'thread-pool.js');
const { POOL_SIZE, poolSize } = require(MODULE);

test('the size: a valid one from the environment is kept, anything else is the default', () => {
  assert.ok(POOL_SIZE >= 16, 'room for many held opens at once');
  assert.equal(poolSize({}), POOL_SIZE);
  assert.equal(poolSize({ UV_THREADPOOL_SIZE: '8' }), 8);
  for (const bad of ['', '0', '-3', '2.5', 'many', '5000']) assert.equal(poolSize({ UV_THREADPOOL_SIZE: bad }), POOL_SIZE, bad);
});

// Eight opens of a FIFO wait for a writer: each holds a pool thread without using any CPU, the
// way an antivirus-held open does. Then one stat. On the default four threads the stat waits
// behind them for good; on the engine's pool it runs at once. Nothing here depends on the cores
// the machine has (16 timed CPU jobs did, and failed on every 3-4 core CI runner). The child
// opens the writer before it exits, so no pool thread is left waiting at shutdown.
function statPastHeldOpens(prelude) {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-pool-'));
  const fifo = join(dir, 'held');
  try {
    execFileSync('mkfifo', [fifo]);
    const script = `${prelude}
      const fs = require('node:fs');
      const fifo = ${JSON.stringify(fifo)};
      const finish = (word) => { process.stdout.write(word); fs.openSync(fifo, 'w'); process.exit(0); };
      for (let i = 0; i < 8; i += 1) fs.open(fifo, 'r', () => {});
      const held = setTimeout(() => finish('held'), 3000);
      fs.stat(${JSON.stringify(HERE)}, () => { clearTimeout(held); finish('ran'); });`;
    const env = { ...process.env };
    delete env.UV_THREADPOOL_SIZE;
    return execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 30000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NO_FIFO = process.platform === 'win32' && 'Windows has no FIFO that holds a pool thread this way';

test('required first, the engine gets the bigger pool', { skip: NO_FIFO }, () => {
  assert.equal(statPastHeldOpens(`require(${JSON.stringify(MODULE)});`), 'ran', 'the stat ran past eight held opens');
  assert.equal(statPastHeldOpens(''), 'held', 'on the default pool it waits behind them (the measure tells them apart)');
});

test('server.js requires it before any module that could use the pool', () => {
  const src = engineSource();
  const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(requires.slice(0, 2), ['./engine/startup-log', './engine/thread-pool.js']);
  const log = readFileSync(join(HERE, '..', 'engine', 'startup-log.js'), 'utf8');
  assert.doesNotMatch(log, /fs\.promises|require\('fs\/promises'\)|\bfs\.(readFile|writeFile|appendFile|stat|open)\(/, 'startup-log.js stays synchronous');
});
