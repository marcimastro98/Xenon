// The reader the tests take a piece of a script with (source-names.mjs): a piece is found
// by its name wherever it stands, ends at its own end, and a name that is missing or
// declared twice fails the test instead of giving the wrong lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { namesOf } from './source-names.mjs';

const TEXT = [
  '(function () {',
  '  const LIMIT = 3;',
  '  let open = null, shut = null;',
  '  const TABLE = {',
  '    a: 1,',
  '',
  '    b: [2, 3],',
  '  };',
  '  // What follows the table is not part of it.',
  '  async function load(id) {',
  '    if (id) {',
  '      return id;',
  '    }',
  '    return null;',
  '  }',
  '  function twice() { return 1; }',
  '  if (LIMIT) {',
  '    function twice() { return 2; }',
  '  }',
  '  const pick = (list) => list',
  '    .filter(Boolean)',
  '    .slice(0, LIMIT);',
  '  class Row {',
  '    paint() {}',
  '  }',
  '  const $el = (id) => id;',
  '})();',
].join('\r\n');

test('a piece is its first line, what stands under it, and the line that closes it', () => {
  const { one } = namesOf(TEXT, 'the sample');
  assert.equal(one('LIMIT'), '  const LIMIT = 3;');
  assert.equal(one('TABLE'), '  const TABLE = {\n    a: 1,\n\n    b: [2, 3],\n  };');
  assert.equal(one('load'), '  async function load(id) {\n    if (id) {\n      return id;\n    }\n    return null;\n  }');
  assert.equal(one('pick'), '  const pick = (list) => list\n    .filter(Boolean)\n    .slice(0, LIMIT);');
  assert.equal(one('Row'), '  class Row {\n    paint() {}\n  }');
  assert.equal(one('$el'), '  const $el = (id) => id;');
});

test('several pieces come in the order asked, and a `let` of two names is found by its first', () => {
  const { all, has } = namesOf(TEXT, 'the sample');
  assert.equal(all('$el', 'LIMIT'), '  const $el = (id) => id;\n  const LIMIT = 3;');
  assert.equal(all('open'), '  let open = null, shut = null;');
  assert.equal(has('load'), true);
  assert.equal(has('shut'), false);
  assert.equal(has('LIM'), false);
});

test('a name that is missing, or declared twice, fails with the label', () => {
  const { one } = namesOf(TEXT, 'the sample');
  assert.throws(() => one('nothing'), /nothing is declared 0 times in the sample/);
  assert.throws(() => one('twice'), /twice is declared 2 times in the sample/);
});
