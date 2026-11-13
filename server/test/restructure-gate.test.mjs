// The list of checks a restructure commit runs (tools/restructure/gate.mjs): every check
// is there, in an order that works, and the ones that stand for an npm script run what
// that script runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { gateSteps } from '../../tools/restructure/gate.mjs';

const ROOT = new URL('../../', import.meta.url);
const scripts = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')).scripts;

test('every check is on the list, the proof first and the server last among the slow ones', () => {
  const names = gateSteps().map((step) => step.name);
  assert.deepEqual(names, ['verify', 'carry', 'map', 'sizes', 'typecheck', 'lint', 'test', 'boot', 'requests', 'personal', 'whitespace']);
});

test('the base commit goes to verify and nowhere else', () => {
  const steps = gateSteps('abc123');
  assert.deepEqual(steps[0].argv.slice(-2), ['--base', 'abc123']);
  assert.equal(steps.slice(1).some((step) => step.argv.includes('abc123')), false);
});

test('a step that stands for an npm script runs the same file with the same arguments', () => {
  const quoted = (text) => [...text.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]);
  for (const step of gateSteps().filter((entry) => entry.npm)) {
    const [node, ...rest] = quoted(scripts[step.npm]);
    assert.equal(node, 'node', step.npm);
    assert.deepEqual(step.argv.filter((arg) => arg !== '--update'), rest, `npm run ${step.npm}`);
  }
});

test('every file a step runs exists, the two server checks use the side port, and each step has a time limit', () => {
  for (const step of gateSteps()) {
    if (!step.git) assert.ok(existsSync(new URL(step.argv[0], ROOT)), step.argv[0]);
    assert.ok(step.minutes > 0 && step.minutes <= 15, step.name);
  }
  for (const name of ['boot', 'requests']) assert.equal(gateSteps().find((step) => step.name === name).env.XENON_PORT, '3039');
});
