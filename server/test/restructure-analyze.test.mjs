// The reader behind tools/restructure: what a top-level declaration is, which
// lines go with it, what it touches, and whether it can leave its file.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { analyze, closureOf, toJson } from '../../tools/restructure/analyze.mjs';
import { readLoadTimeCalls } from '../../tools/restructure/load-time-calls.mjs';
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
  const a = read(['const os = require("os");', 'const SIZE = 512 * 1024;', 'const UP = os.uptime();',
    'const TABLE = Object.freeze({ a: [1, 2], b: new Set(["x"]) });', 'const PICK = SIZE > 1 ? "big" : "small";',
    'const made = build();', 'function build() { return {}; }', 'if (SIZE) { var leaked = 1; }', ''].join('\n'));
  assert.equal(record(a, 'SIZE').loadTime, false);
  assert.equal(record(a, 'TABLE').loadTime, false);
  assert.equal(record(a, 'PICK').loadTime, false);
  assert.deepEqual(codes(a, 'UP'), ['runs-code-at-load']);
  assert.deepEqual(codes(a, 'made'), ['runs-code-at-load']);
  assert.deepEqual(record(a, 'leaked').kind, 'statement', 'a var inside an if belongs to that statement');
});

test('a value worked out with a listed call of a Node module moves; any other call still holds it', (t) => {
  if (!parser) return t.skip(SKIP);
  const a = read(['const os = require("os");', 'const path = require("node:path");', 'const fs = require("fs");',
    'const mine = require("./mine.js");', 'const other = { homedir: () => "x" };',
    'const HOME = path.join(os.homedir(), "docs");', 'const DEFAULTS = Object.freeze({ dir: os.tmpdir(), win: process.platform === "win32", arch: os.arch() });',
    'const UP = os.uptime();', 'const FILE = fs.readFileSync("x");', 'const MINE = mine.homedir();', 'const FAKE = other.homedir();',
    'const NAMES = ["a"].map((os) => os.homedir());', 'const ENV = process.env.HOME || "";', ''].join('\n'));
  for (const name of ['HOME', 'DEFAULTS', 'ENV']) {
    assert.equal(record(a, name).loadTime, false, name);
    assert.deepEqual(record(a, name).loadCalls, [], name);
  }
  assert.deepEqual(record(a, 'UP').loadCalls, ['os.uptime()'], 'a function of the same module that is not listed');
  assert.deepEqual(record(a, 'FILE').loadCalls, ['fs.readFileSync()'], 'a module that is not listed at all');
  assert.deepEqual(record(a, 'MINE').loadCalls, ['mine.homedir()'], 'the name of a listed function on a module of the project');
  assert.deepEqual(record(a, 'FAKE').loadCalls, ['other.homedir()'], 'the name of a listed function on a plain object');
  assert.equal(record(a, 'NAMES').loadTime, true, 'a parameter called like the module hides it');
  for (const name of ['UP', 'FILE', 'MINE', 'FAKE', 'NAMES']) assert.ok(codes(a, name).includes('runs-code-at-load'), name);
  assert.deepEqual(toJson(a).declarations.find((d) => d.names[0] === 'UP').loadTimeCalls, ['os.uptime()'], '`analyze` says which call holds it');
});

test('the list is what decides: with another list the same code is held or free', (t) => {
  if (!parser) return t.skip(SKIP);
  const text = 'const os = require("os");\nconst HOME = os.homedir();\nconst TABLE = Object.freeze({ a: 1 });\n';
  const none = analyze(text, parser, 'demo.js', { calls: readLoadTimeCalls({}) });
  assert.deepEqual(record(none, 'HOME').loadCalls, ['os.homedir()']);
  assert.deepEqual(record(none, 'TABLE').loadCalls, ['Object.freeze()']);
  const some = analyze(text, parser, 'demo.js', { calls: readLoadTimeCalls({ functions: ['Object.freeze'], moduleFunctions: { os: ['homedir'] } }) });
  assert.equal(record(some, 'HOME').loadTime, false);
  assert.equal(record(some, 'TABLE').loadTime, false);
  assert.throws(() => readLoadTimeCalls({ functions: 'Object.freeze' }), /functions must be a list of names/);
  assert.throws(() => readLoadTimeCalls({ moduleFunctions: { os: [1] } }), /moduleFunctions\.os must be a list of names/);
});

test('the list in the repo explains itself and names only modules that compute', () => {
  const json = JSON.parse(readFileSync(new URL('../../tools/restructure/load-time-calls.json', import.meta.url), 'utf8'));
  assert.ok(json.note.length > 200, 'the note says what the rule is and when a name may be added');
  const calls = readLoadTimeCalls(json);
  assert.deepEqual([...calls.moduleFunctions.keys()].sort(), ['os', 'path'], 'no module that reads files, starts programs or opens sockets');
  assert.deepEqual([...calls.moduleFunctions.get('os')].sort(), ['arch', 'homedir', 'platform', 'tmpdir']);
  assert.deepEqual([...calls.moduleFunctions.get('path')].sort(), ['basename', 'dirname', 'join', 'resolve']);
  for (const key of ['functions', 'constructors', 'methods', 'methodsTakingAFunction']) {
    assert.deepEqual(json[key], [...new Set(json[key])].sort(), `${key} is sorted and names nothing twice`);
  }
  for (const name of ['Date.now', 'Math.random', 'require', 'JSON.parse']) assert.ok(!calls.functions.has(name), `${name} is not on the list`);
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
