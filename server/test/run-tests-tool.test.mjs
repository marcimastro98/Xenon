// tools/run-tests.mjs: the suite's own temp folder, so tests stop filling the system Temp.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { testEnv } from '../../tools/run-tests.mjs';

test('every temp variable points at the run folder, the rest is kept', () => {
  const env = testEnv({ PATH: 'p', TEMP: 'old', TMP: 'old' }, 'run');
  assert.deepEqual(env, { PATH: 'p', TEMP: 'run', TMP: 'run', TMPDIR: 'run' });
});

test('npm test goes through the runner', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.test, /^node tools\/run-tests\.mjs /);
});

test('the suite runs inside the runner folder', { skip: !process.env.TEMP?.includes('xenon-test-run-') && !process.env.TMPDIR?.includes('xenon-test-run-') && 'run outside npm test' }, async () => {
  const { tmpdir } = await import('node:os');
  assert.match(tmpdir(), /xenon-test-run-/);
});
