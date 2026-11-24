// The ceiling of a fan tick's wait: it ends on time even when nothing else keeps the process alive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const WITHIN = fileURLToPath(new URL('../airflow/within.js', import.meta.url));
const { within } = require(WITHIN);

test('within: settles when the promise does, a rejection included', async () => {
  await within(Promise.resolve(1), 5000);
  await within(Promise.reject(new Error('read failed')), 5000);
});

test('within: a promise that never lands still ends the wait after the ceiling', async () => {
  const started = Date.now();
  await within(new Promise(() => {}), 30);
  assert.ok(Date.now() - started < 2000);
});

test('within: the wait ends in a process with nothing else alive', () => {
  const script = `require(${JSON.stringify(WITHIN)}).within(new Promise(() => {}), 30).then(() => process.stdout.write('ended'));`;
  assert.equal(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 }), 'ended');
});
