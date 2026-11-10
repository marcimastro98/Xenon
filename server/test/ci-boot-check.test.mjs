// The macOS/Linux CI boot check: what it counts as a broken server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootProblems } from '../../tools/ci/boot-check.mjs';

test('a dashboard page, a JSON catalog and quiet output is a clean boot', () => {
  const output = '[node] Node.js v20.19.5 is no longer supported: update it\nXenon listening on 127.0.0.1:3039\n';
  assert.deepEqual(bootProblems({ pageStatus: 200, catalog: { actions: [] }, output }), []);
});

test('no answer, a missing catalog and crash lines are each named', () => {
  const p = bootProblems({ pageStatus: undefined, catalog: null, output: 'ok\nTypeError: x is not a function\n  at y\n' });
  assert.equal(p.length, 3);
  assert.match(p[0], /answered nothing/);
  assert.match(p[1], /not JSON/);
  assert.match(p[2], /TypeError: x is not a function/);
});

test('a missing optional tool is a warning, not a crash', () => {
  const output = 'spawn pw-dump ENOENT (audio unavailable)\nwarn: ffmpeg not found\n';
  assert.deepEqual(bootProblems({ pageStatus: 200, catalog: {}, output }), []);
});
