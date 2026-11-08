// tools/mutate: a plan is checked before any file is touched, a mutation hits its text
// only when the text is there once, and the failing tests are read from the TAP report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, applyOnce, eolLike, failedTests } from '../../tools/mutate/mutate.mjs';

test('a plan written with \\n finds its text in a file with \\r\\n line ends', () => {
  const crlf = 'a {\r\n  b: 1;\r\n}\r\n';
  assert.equal(eolLike(crlf, '  b: 1;\n}'), '  b: 1;\r\n}');
  assert.equal(eolLike(crlf, '  b: 1;\r\n}'), '  b: 1;\r\n}', 'already \\r\\n stays as it is');
  assert.equal(eolLike('a {\n  b: 1;\n}\n', '  b: 1;\n}'), '  b: 1;\n}');
  assert.equal(applyOnce(crlf, eolLike(crlf, '{\n  b: 1;\n'), eolLike(crlf, '{\n')), 'a {\r\n}\r\n');
});

test('a plan needs tests and named mutations, and `to` defaults to nothing', () => {
  const plan = parsePlan({ tests: ['a.test.mjs'], mutations: [{ name: 'gone', file: 'x.css', from: 'a { }' }] });
  assert.deepEqual(plan.mutations, [{ name: 'gone', file: 'x.css', from: 'a { }', to: '' }]);
  for (const bad of [null, {}, { tests: [], mutations: [] }, { tests: ['a'], mutations: [{ name: 'n', file: 'f' }] },
    { tests: ['a'], mutations: [{ name: 'n', file: 'f', from: '' }] }, { tests: ['a'], mutations: [{ name: 'n', file: 'f', from: 'x', to: 3 }] }]) {
    assert.throws(() => parsePlan(bad), /a plan needs/, JSON.stringify(bad));
  }
});

test('a mutation hits its text only when it appears exactly once', () => {
  assert.equal(applyOnce('a b c', 'b', 'B'), 'a B c');
  assert.equal(applyOnce('a b c', 'b ', ''), 'a c');
  assert.equal(applyOnce('a b b', 'b', 'B'), null, 'twice: which one is meant is unclear');
  assert.equal(applyOnce('a c', 'b', 'B'), null);
  // Text with $ is taken as written, not as a replacement pattern.
  assert.equal(applyOnce('x', 'x', '$&$&'), '$&$&');
});

test('the failing tests come from the TAP report, each once, todo and skip aside', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: first',
    'ok 1 - first',
    '    not ok 1 - inner part',
    'not ok 2 - later # TODO not written yet',
    'not ok 3 - elsewhere # SKIP',
    'not ok 4 - second test',
    'not ok 5 - second test',
    'not ok 6 - a test with \\# in its name and a \\\\',
    '# fail 2',
  ].join('\r\n');
  assert.deepEqual(failedTests(tap), ['inner part', 'second test', 'a test with # in its name and a \\']);
  assert.deepEqual(failedTests('ok 1 - fine\n# pass 1'), []);
});
