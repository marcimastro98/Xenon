// The tool that runs the suite on a busy machine (tools/ci/tests-under-load.mjs): what it
// reads from its command line and from the test runner's text.
import test from 'node:test';
import assert from 'node:assert/strict';

import { failedTests, loadOptions } from '../../tools/ci/tests-under-load.mjs';

test('with nothing asked it keeps every processor busy and runs the whole suite', () => {
  const options = loadOptions([], 8);
  assert.equal(options.burners, 8);
  assert.equal(options.minutes, 25);
  assert.deepEqual(options.files, ['server/test/*.test.mjs', 'packages/core/test/*.test.mjs', 'packages/mcp/test/*.test.mjs']);
});

test('the number of busy processes, the limit and the files can be chosen', () => {
  const options = loadOptions(['--burners', '3', 'server/test/a.test.mjs', '--minutes', '5', 'server/test/b.test.mjs'], 8);
  assert.deepEqual(options, { burners: 3, minutes: 5, files: ['server/test/a.test.mjs', 'server/test/b.test.mjs'] });
});

test('a number that makes no sense is refused', () => {
  assert.throws(() => loadOptions(['--burners', '0'], 8), /--burners/);
  assert.throws(() => loadOptions(['--burners', 'many'], 8), /--burners/);
  assert.throws(() => loadOptions(['--minutes', '0'], 8), /--minutes/);
  assert.throws(() => loadOptions(['--minutes', '600'], 8), /--minutes/);
});

test('the failed tests are read from the list at the end, each once, with where they are', () => {
  const output = [
    '✖ an early line that is not in the list (2ms)',
    'ℹ fail 2',
    '',
    '✖ failing tests:',
    '',
    'test at server/test/one.test.mjs:12:1',
    '✖ the first one (3ms)',
    '  AssertionError: 1 !== 2',
    'test at server/test/two.test.mjs:40:1',
    '✖ the second one (9ms)',
  ].join('\n');
  assert.deepEqual(failedTests(output), [
    'the first one (3ms)  [server/test/one.test.mjs:12:1]',
    'the second one (9ms)  [server/test/two.test.mjs:40:1]',
  ]);
  assert.deepEqual(failedTests('ℹ fail 0'), []);
});
