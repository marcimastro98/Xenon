// A `require('x');` that stands alone on a line (tools/restructure, `bare`): what counts as a file
// that runs nothing when it loads, which requires are followed, the three ways a line is proven
// dead, every reason a line stays, and that taking the dead lines out loads the same files in the
// same order when the code is really run.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { judgeBareRequires, loadFacts } from '../../tools/restructure/bare-requires.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';
const file = (...lines) => `${lines.join('\n')}\n`;
// A file that says so when it loads.
const NOISY = 'globalThis.xenonLoads.push(__filename.slice(-4));';
const QUIET = file("'use strict';", "const path = require('path');", "const { A } = require('./leaf');", 'function join(a) { return path.join(a, A); }', 'module.exports = { join };');

function judge(files, judged = Object.keys(files).filter((name) => name.endsWith('.js')), real = undefined) {
  const { rows, unseen } = judgeBareRequires({ files: judged, read: (name) => files[name] ?? null, parser, real });
  return { rows, unseen, of: (name) => rows.filter((row) => row.file === name).map((row) => `${row.line} ${row.verdict}: ${row.why}`) };
}

test('a file runs nothing when it loads only if every statement declares, requires or exports a plain value', (t) => {
  if (!parser) return t.skip(SKIP);
  const declares = file("'use strict';", '', "const path = require('path');", "const { a, b: c } = require('./ab');", "const d = require('./d').d;", "require('./e');",
    'const LIMIT = 5 * 1000;', "const NAMES = ['a', 'b'];", 'let count = 0;', 'var old;', 'function f() { return count + LIMIT; }',
    'class Thing { run() { return f(); } }', 'class Other extends Thing {}', ';', 'module.exports = { f, Thing, NAMES, old, path, a, c, d };',
    'module.exports.Other = Other;', 'exports.LIMIT = LIMIT;');
  assert.deepEqual(loadFacts(declares, parser).runs, []);
  const running = ['start();', 'if (process.env.X) count = 1;', 'try { f(); } catch { /* nothing */ }', 'for (const name of NAMES) f(name);',
    "process.on('exit', f);", 'module.exports = make();', 'exports.a = run();', 'settings.limit = 5;', 'globalThis.thing = 1;', 'count += 1;',
    'module.exports.a.b = 1;', 'const made = make();', "const loaded = require('./x')();", "const one = require('./x'), two = require('./y');",
    "module.exports = require('./x');", 'class A { static { start(); } }', 'class B extends mix(Base) {}', 'class C { static made = make(); }',
    'class D { [name()]() {} }', '(function () {})();'];
  for (const line of running) {
    const { runs } = loadFacts(file("'use strict';", line), parser);
    assert.deepEqual(runs.map((row) => row.line), [2], line);
  }
  assert.deepEqual(loadFacts(file('start();', 'const a = 1;', 'stop(a);'), parser).runs, [{ line: 1, text: 'start()' }, { line: 3, text: 'stop(a)' }]);
});

test('a require is sure when it is a statement of its own at the top of the file, and any other use of the word is told', (t) => {
  if (!parser) return t.skip(SKIP);
  const facts = loadFacts(file("const a = require('./a');", "require('./b');", 'function later() {', "  require('./c');", "  return require('./d');", '}',
    "const e = process.env.E ? require('./e') : null;", "if (a) require('./f');", 'const g = require(name);', 'const load = require;',
    "module.require('./h');", 'if (require.main === module) later();', "const where = require.resolve('./i');", "/** @type {import('./j')} */", 'const k = null;',
    "const l = typeof require === 'function' ? 1 : 0;"), parser);
  assert.deepEqual(facts.requires, [
    { spec: './a', line: 1, sure: true, bare: false },
    { spec: './b', line: 2, sure: true, bare: true },
    { spec: './c', line: 4, sure: false, bare: true },
    { spec: './d', line: 5, sure: false, bare: false },
    { spec: './e', line: 7, sure: false, bare: false },
    { spec: './f', line: 8, sure: false, bare: true },
  ]);
  assert.deepEqual(facts.unseen, [9, 10, 11], 'a worked-out name, the function handed on, a property called require');
});

test('a line is dead when an earlier line of the same file already loads the same file, whatever that file runs', (t) => {
  if (!parser) return t.skip(SKIP);
  const files = { 'server/a.js': file("const b = require('./b');", "require('./b.js');", "require('./c');", "const c = require('./c');"), 'server/b.js': file(NOISY), 'server/c.js': file(NOISY) };
  assert.deepEqual(judge(files).of('server/a.js'), [
    '2 dead: line 1 of the same file already loads server/b.js',
    `3 stays: server/c.js runs code when it loads (line 1: ${NOISY.slice(0, -1)})`,
  ]);
  // One file under two names, as server/shared is packages/core.
  const linked = { 'server/a.js': file("const x = require('./shared/x');", "require('../packages/core/x');"), 'packages/core/x.js': file(NOISY) };
  const read = (name) => linked[name.replace('server/shared/', 'packages/core/')] ?? null;
  const { rows } = judgeBareRequires({ files: ['server/a.js'], read, parser, real: (name) => name.replace('server/shared/', 'packages/core/') });
  assert.deepEqual(rows.map((row) => row.why), ['line 1 of the same file already loads packages/core/x.js']);
});

const THROUGH = {
  'server/main.js': file("const m = require('./m');", "require('./t');"),
  'server/m.js': file("const mid = require('./mid');", NOISY),
  'server/mid.js': file("const t = require('./t');", 'module.exports = { t };'),
  'server/t.js': file(NOISY),
};

test('a line is dead when an earlier line loads a file that always loads it first, unless the way can lead back', (t) => {
  if (!parser) return t.skip(SKIP);
  const main = (files) => judge({ ...THROUGH, ...files }).of('server/main.js');
  const stays = [`2 stays: server/t.js runs code when it loads (line 1: ${NOISY.slice(0, -1)})`];
  assert.deepEqual(main({}), ['2 dead: line 1 loads server/m.js, which always loads server/t.js first']);
  assert.deepEqual(main({ 'server/m.js': file("function mid() { return require('./mid'); }", NOISY) }), stays, 'asked for inside a function: not always');
  assert.deepEqual(main({ 'server/mid.js': file("const t = require('./t');", "function again() { return require('./main'); }") }), stays, 'a circle');
  assert.deepEqual(main({ 'server/m.js': file("const mid = require('./mid');", "const side = require('./side');"),
    'server/side.js': file("function again() { return require('./main'); }") }), stays, 'a circle through a file next to the way');
  assert.deepEqual(main({ 'server/m.js': file("const mid = require('./mid');", 'const load = require;') }), stays, 'a require nobody can follow');
  // The other order proves nothing: the line is what loads t first.
  assert.deepEqual(judge({ ...THROUGH, 'server/main.js': file("require('./t');", "const m = require('./m');") }).of('server/main.js'), ['1 stays: server/t.js runs code when it loads (line 1: ' + NOISY.slice(0, -1) + ')']);
});

const PLAIN = {
  'server/q.js': file("require('./quiet');", "require('./data.json');", "require('fs');", "require('./folder');", "require('inspector');", "require('ws');",
    "require('./nowhere');", 'function f() {', "  require('./later');", '}'),
  'server/quiet.js': QUIET,
  'server/leaf.js': file("module.exports = { A: 'a' };"),
  'server/data.json': '{ "a": 1 }',
  'server/folder/index.js': file('module.exports = {};'),
  'server/later.js': file('module.exports = {};'),
};

test('a line is dead when the file and all it loads only declare, and every other case stays with its reason', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.deepEqual(judge(PLAIN, ['server/q.js']).of('server/q.js'), [
    '1 dead: server/quiet.js and all it loads only declare: nothing runs when they load',
    '2 dead: server/data.json and all it loads only declare: nothing runs when they load',
    '3 dead: fs is a module of Node that does nothing when loaded',
    '4 dead: server/folder/index.js and all it loads only declare: nothing runs when they load',
    '5 stays: inspector is a module of Node that is not on the list of those that do nothing when loaded',
    '6 stays: ws is a package: what it runs when it loads is not read',
    '7 stays: it names no file here: the line fails when it runs, and taking it out would hide that',
    '9 stays: it is inside a function or a block: when it runs is not read',
  ]);
  const first = (files, judged) => judge({ ...PLAIN, ...files }, judged).of('server/q.js')[0];
  assert.equal(first({ 'server/leaf.js': file("module.exports = { A: 'a' };", 'start();') }), '1 stays: server/leaf.js runs code when it loads (line 2: start())');
  assert.equal(first({ 'server/leaf.js': file("const ws = require('ws');", 'module.exports = { A: ws };') }), '1 stays: server/leaf.js loads the package ws, which is not read');
  assert.equal(first({ 'server/leaf.js': file("const v8 = require('v8');", 'module.exports = { A: v8 };') }),
    '1 stays: server/leaf.js loads v8, a module of Node that is not on the list of those that do nothing when loaded');
  assert.equal(first({ 'server/leaf.js': file("const gone = require('./gone');", 'module.exports = { A: gone };') }), '1 stays: server/leaf.js asks for ./gone, which is no file here');
  assert.equal(first({ 'server/leaf.js': file('const load = require;', "module.exports = { A: 'a' };") }), '1 stays: server/leaf.js uses require in a way that is not followed (line 1)');
  // With the line gone, the first to ask would be a function in the middle of its work.
  const other = { 'server/other.js': file('function later() {', "  return require('./leaf');", '}') };
  assert.equal(first(other), '1 stays: server/other.js:2 asks for server/leaf.js from inside a function or a condition: without this line the file could be read from disk there');
  assert.match(first(other, ['server/q.js']), /^1 dead/, 'a file that is not part of the app (a test) does not count');
  assert.equal(judge({ ...PLAIN, 'server/data.json': '{ a: 1 ' }).of('server/q.js')[1], '2 stays: server/data.json is not JSON that can be read: loading it fails');
  assert.equal(judge({ ...PLAIN, 'server/q.js': file("require('./native.node');"), 'server/native.node': 'x' }).of('server/q.js')[0],
    '1 stays: server/native.node is not a .js or .json file: what loading it does is not read');
});

function loadsOf(files, entry) {
  const root = mkdtempSync(join(tmpdir(), 'xenon-bare-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), text);
    }
    globalThis.xenonLoads = [];
    createRequire(join(root, 'x.js'))(`./${entry}`);
    return globalThis.xenonLoads;
  } finally {
    delete globalThis.xenonLoads;
    rmSync(root, { recursive: true, force: true });
  }
}
// The files without the lines of these rows.
function without(files, rows) {
  const out = { ...files };
  for (const row of [...rows].sort((a, b) => b.line - a.line)) {
    const lines = out[row.file].split('\n');
    lines.splice(row.line - 1, 1);
    out[row.file] = lines.join('\n');
  }
  return out;
}

test('run for real, the files load in the same order without the dead lines, and not without a line that stays', (t) => {
  if (!parser) return t.skip(SKIP);
  const cases = [
    [{ 'server/a.js': file("const b = require('./b');", "require('./b');", "const c = require('./c');"), 'server/b.js': file(NOISY), 'server/c.js': file(NOISY) }, 'server/a.js', ['b.js', 'c.js']],
    [{ ...THROUGH, 'server/main.js': file("const m = require('./m');", "require('./t');", "const c = require('./c');"), 'server/c.js': file(NOISY) }, 'server/main.js', ['t.js', 'm.js', 'c.js']],
    [{ 'server/a.js': file("require('./quiet');", "const c = require('./c');"), 'server/quiet.js': QUIET, 'server/leaf.js': PLAIN['server/leaf.js'], 'server/c.js': file(NOISY) }, 'server/a.js', ['c.js']],
  ];
  for (const [files, entry, order] of cases) {
    const { rows } = judge(files);
    assert.deepEqual(rows.map((row) => row.verdict), ['dead'], entry);
    assert.deepEqual(loadsOf(files, entry), order);
    assert.deepEqual(loadsOf(without(files, rows), entry), order, 'the same without the line');
  }
  const kept = { ...THROUGH, 'server/main.js': file("require('./t');", "const c = require('./c');", "const m = require('./m');"), 'server/c.js': file(NOISY) };
  const { rows } = judge(kept);
  assert.deepEqual(rows.map((row) => row.verdict), ['stays']);
  assert.deepEqual([loadsOf(kept, 'server/main.js'), loadsOf(without(kept, rows), 'server/main.js')], [['t.js', 'c.js', 'm.js'], ['c.js', 't.js', 'm.js']]);
});
