// The parser the restructure tools share (tools/restructure/parser.mjs): one
// compiler for many parses. A parse must cost the same whether it is the first
// or the five hundredth, so the compiler may hold one file at a time, and a tree
// handed back must stay readable after the parses that follow it.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const scriptOf = (index) => `'use strict';\n\nconst value${index} = ${index};\n\nfunction read${index}() {\n  return value${index};\n}\n`;

function namesIn(tree, K) {
  const names = [];
  const walk = (node) => {
    if (node.kind === K.Identifier) names.push(node.text);
    node.forEachChild(walk);
  };
  walk(tree);
  return names;
}

test('the compiler holds one file, however many were parsed before', (t) => {
  if (!parser) return t.skip(SKIP);
  const held = [];
  for (let index = 0; index < 12; index += 1) {
    parser.parse(scriptOf(index), 'script.js');
    held.push(parser.held());
  }
  assert.deepEqual(held, new Array(12).fill(1), 'a file left open is rebuilt with every parse after it');
});

test('a tree stays whole after later parses, the same name included', (t) => {
  if (!parser) return t.skip(SKIP);
  const trees = [];
  for (let index = 0; index < 8; index += 1) trees.push(parser.parse(scriptOf(index), 'script.js'));
  for (const [index, tree] of trees.entries()) {
    assert.equal(tree.text, scriptOf(index));
    assert.deepEqual(namesIn(tree, parser.K), [`value${index}`, `read${index}`, `value${index}`]);
  }
});

test('the same text parsed twice gives two trees that read alike', (t) => {
  if (!parser) return t.skip(SKIP);
  const first = parser.parse(scriptOf(1), 'a.js');
  parser.parse(scriptOf(2), 'b.js');
  const again = parser.parse(scriptOf(1), 'a.js');
  assert.deepEqual(namesIn(again, parser.K), namesIn(first, parser.K));
  assert.equal(again.statements.length, first.statements.length);
});
