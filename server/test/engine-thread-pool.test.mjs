// libuv's shared pool sized before its first use (server/engine/thread-pool.js): four
// antivirus-held file opens filled the default pool of four and every file call in the engine
// waited behind them, fan commands included (23 Nov 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Sixteen equal jobs on the pool: on four threads they finish in four waves (the first done
// at about a quarter of the time the last took); on enough threads, together. The cores the
// PC has do not change this: the system shares them fairly among the threads running.
function firstToLast(prelude) {
  const script = `${prelude}
    const { pbkdf2 } = require('node:crypto');
    const start = Date.now();
    const done = [];
    let left = 16;
    for (let i = 0; i < 16; i += 1) pbkdf2('x', 'y', 400000, 32, 'sha256', () => {
      done.push(Date.now() - start);
      if (--left === 0) process.stdout.write(String(Math.min(...done) / Math.max(...done)));
    });`;
  const env = { ...process.env };
  delete env.UV_THREADPOOL_SIZE;
  return Number(execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 60000 }));
}

test('required first, the engine gets the bigger pool', () => {
  assert.ok(firstToLast(`require(${JSON.stringify(MODULE)});`) > 0.45, 'all sixteen ran together');
  assert.ok(firstToLast('') < 0.4, 'the default pool runs them in waves (the measure tells them apart)');
});

test('server.js requires it before any module that could use the pool', () => {
  const src = readFileSync(join(HERE, '..', 'server.js'), 'utf8');
  const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(requires.slice(0, 2), ['./engine/startup-log', './engine/thread-pool.js']);
  const log = readFileSync(join(HERE, '..', 'engine', 'startup-log.js'), 'utf8');
  assert.doesNotMatch(log, /fs\.promises|require\('fs\/promises'\)|\bfs\.(readFile|writeFile|appendFile|stat|open)\(/, 'startup-log.js stays synchronous');
});
