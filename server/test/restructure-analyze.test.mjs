// The reader behind tools/restructure: what a top-level declaration is, which
// lines go with it, what it touches, and whether it can leave its file.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { analyze, closureOf, toJson } from '../../tools/restructure/analyze.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const read = (text) => analyze(text, parser, 'demo.js');
const record = (analysis, name) => analysis.bindings.get(name).record;
const codes = (analysis, name) => record(analysis, name).blockers.map((blocker) => blocker.code);

test('a declaration takes its comment block and the blank line after it', (t) => {
  if (!parser) return t.skip(SKIP);
  const a = read(['const fs = require("fs");', '', '// Two lines', '// of comment.', 'function one() {', '  return 1;', '}', '',
    'const TWO = 2; // same line', '', '', 'let three = 3;', 'console.log(one());', ''].join('\n'));
  assert.deepEqual(a.records.map((r) => r.kind), ['require', 'function', 'const', 'let', 'statement']);
  assert.deepEqual(record(a, 'one').line, [5, 7]);
  assert.deepEqual(record(a, 'one').range, [3, 8], 'the comment above and the blank line below go with it');
  assert.deepEqual(record(a, 'TWO').range, [9, 11]);
  assert.equal(record(a, 'fs').require.spec, 'fs');
  assert.equal(a.lineCount, 13);
});

test('a comment separated by a blank line stays where it is', (t) => {
  if (!parser) return t.skip(SKIP);
  const a = read('// A section title.\n\nfunction one() {}\nfunction two() {}\n');
  assert.deepEqual(record(a, 'one').range, [3, 3]);
  assert.deepEqual(record(a, 'two').range, [4, 4], 'no blank line before it, so it leaves none behind');
});

test('reads, reassignments and changes in place are told apart', (t) => {
  if (!parser) return t.skip(SKIP);
  const a = read(['let count = 0;', 'const list = [];', 'const LIMIT = 5;',
    'function bump() { count += 1; }', 'function add(x) { list.push(x); }', 'function peek() { return count; }',
    'function ok(n) { return n < LIMIT; }', 'function shadow(count) { count = 1; return count; }',
    'function destructure() { [count] = [2]; }', ''].join('\n'));
  assert.deepEqual(codes(a, 'bump'), ['reassigns']);
  assert.deepEqual(codes(a, 'destructure'), ['reassigns']);
  assert.deepEqual(codes(a, 'add'), ['changes-in-place']);
  assert.deepEqual(codes(a, 'peek'), ['reads-state']);
  assert.deepEqual(codes(a, 'list'), ['is-shared-state'], 'a const that is changed in place is shared state');
  assert.deepEqual(record(a, 'shadow').deps, [], 'a parameter hides the variable of the same name');
  assert.deepEqual(toJson(a).movable, ['LIMIT', 'ok', 'shadow']);
});

test('what runs when the file loads does not move, plain values do', (t) => {
  if (!parser) return t.skip(SKIP);
  const a = read(['const os = require("os");', 'const SIZE = 512 * 1024;', 'const HOME = os.homedir();',
    'const TABLE = Object.freeze({ a: [1, 2], b: new Set(["x"]) });', 'const PICK = SIZE > 1 ? "big" : "small";',
    'const made = build();', 'function build() { return {}; }', 'if (SIZE) { var leaked = 1; }', ''].join('\n'));
  assert.equal(record(a, 'SIZE').loadTime, false);
  assert.equal(record(a, 'TABLE').loadTime, false);
  assert.equal(record(a, 'PICK').loadTime, false);
  assert.deepEqual(codes(a, 'HOME'), ['runs-code-at-load']);
  assert.deepEqual(codes(a, 'made'), ['runs-code-at-load']);
  assert.deepEqual(record(a, 'leaked').kind, 'statement', 'a var inside an if belongs to that statement');
});

test('code tied to its file, or needing something that cannot move, stays', (t) => {
  if (!parser) return t.skip(SKIP);
  const a = read(['let state = 0;', 'function here() { return __dirname; }', 'function lazy() { return require("./x"); }',
    'function touch() { state += 1; }', 'function user() { touch(); }', 'function leaf() { return 1; }',
    'function top() { return leaf(); }', ''].join('\n'));
  assert.deepEqual(codes(a, 'here'), ['bound-to-this-file']);
  assert.deepEqual(codes(a, 'lazy'), ['bound-to-this-file']);
  assert.deepEqual(codes(a, 'user'), ['needs']);
  assert.equal(record(a, 'top').movable, true);
  assert.deepEqual(closureOf(a, ['top']).flatMap((r) => r.names), ['leaf', 'top']);
});

test('a callback handed over while the file loads holds back what needs a later module', (t) => {
  if (!parser) return t.skip(SKIP);
  const a = read(['const early = require("./early");', 'const hub = early.create({ onEnd: () => save() });',
    'const late = require("./late");', 'const path = require("path");',
    'function save() { return late.write(path.join("a", "b")); }', 'function tidy() { return early.clean(); }', ''].join('\n'));
  const [blocker] = record(a, 'save').blockers;
  assert.equal(blocker.code, 'needs-a-module-loaded-later');
  assert.deepEqual(blocker.names, ['late'], 'a built-in module can load at any time, ./late cannot');
  assert.equal(blocker.usedFromLine, 2);
  assert.equal(record(a, 'tidy').movable, true);
});
