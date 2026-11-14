// A move that leaves `require('x');` standing alone (tools/restructure, dead-requires.mjs): the
// line goes when the rule of `bare` proves it dead and stays with a reason otherwise, the plan
// without it still proves itself, `extract` and `inner` do it on disk and record it, and `verify`
// redoes it and says when a recorded line is no longer proven.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyze } from '../../tools/restructure/analyze.mjs';
import { bareLines, dropDeadRequires, leavesBare } from '../../tools/restructure/dead-requires.mjs';
import { serverFilesOnDisk } from '../../tools/restructure/dead-requires-disk.mjs';
import { extract, replay } from '../../tools/restructure/extract.mjs';
import { planExtraction } from '../../tools/restructure/extract-plan.mjs';
import { moveInner } from '../../tools/restructure/inner.mjs';
import { planInner } from '../../tools/restructure/inner-plan.mjs';
import { proveInner } from '../../tools/restructure/inner-proof.mjs';
import { PROTECTED, readLedger } from '../../tools/restructure/ledger.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { proveMove } from '../../tools/restructure/verify.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';
const file = (...lines) => `${lines.join('\n')}\n`;
const [OLD, NEW, ABOUT] = ['server/demo.js', 'server/part/x.js', 'What the part does.'];
// The new module is one folder deeper than the old file.
const rewrite = (spec) => (spec === 'path' ? { spec: 'node:path', kind: 'builtin', file: null }
  : { spec: `.${spec}.js`, kind: 'file', file: `server/${spec.slice(2)}.js` });

const SOURCE = file("'use strict';", "const path = require('path');", "const { clean } = require('./lib');", "const { other } = require('./noisy');", '',
  '// Joins and cleans.', 'function tidy(a) {', "  return clean(path.join(a, 'x'));", '}', '', 'function shout(a) { return other(a); }', '',
  'function run(a) { return tidy(a); }', '', 'function plain(a) { return a; }', '', 'module.exports = { run, shout, plain };');
const LIB = file("'use strict';", 'function clean(a) { return String(a).trim(); }', 'module.exports = { clean };');
const NOISY = file("'use strict';", 'globalThis.loud = true;', 'function other(a) { return a; }', 'module.exports = { other };');
const TREE = { [OLD]: SOURCE, 'server/lib.js': LIB, 'server/noisy.js': NOISY };

const planOf = (text, names) => planExtraction({ text, analysis: analyze(text, parser, OLD), names, source: OLD, target: NEW, about: ABOUT, rewrite });
function drop(tree, names, more = {}) {
  const plain = planOf(tree[OLD], names);
  const out = dropDeadRequires({ plan: plain, source: OLD, target: NEW, parser, files: Object.keys(tree), read: (name) => tree[name] ?? null, ...more });
  return { ...out, plain, proof: proveMove({ before: tree[OLD], after: out.plan.newSource, moduleText: out.plan.moduleText, plan: out.plan }) };
}
const QUIET = 'server/lib.js and all it loads only declare: nothing runs when they load';

test('a require the moved code was the last user of goes when what it loads only declares, and the plan still proves itself', (t) => {
  if (!parser) return t.skip(SKIP);
  const plain = planOf(SOURCE, ['tidy']);
  assert.ok(plain.newSource.includes("\nrequire('./lib');\n"), 'the move alone leaves the line');
  assert.equal(leavesBare(plain), true);

  const done = drop(TREE, ['tidy']);
  assert.deepEqual(done.dropped, [{ spec: './lib', why: QUIET }]);
  assert.deepEqual([done.kept, done.problems, done.proof], [[], [], []]);
  assert.equal(done.plan.newSource, plain.newSource.replace("require('./lib');\n", ''));
  assert.equal(done.plan.moduleText, plain.moduleText, 'the new module is the same either way');
  assert.equal(plain.newSource.includes("require('./lib');"), true, 'the plan that came in is not changed');
});

test('a line stays, with the reason, when what it loads runs code, is asked for later, or has a comment above it', (t) => {
  if (!parser) return t.skip(SKIP);
  const loud = drop(TREE, ['shout']);
  assert.equal(loud.plan, loud.plain, 'nothing was taken: the same plan comes back');
  assert.deepEqual(loud.dropped, []);
  assert.equal(loud.kept.length, 1);
  assert.equal(loud.kept[0].spec, './noisy');
  assert.match(loud.kept[0].why, /server\/noisy\.js runs code when it loads \(line 2: globalThis\.loud = true\)/);

  const late = drop({ ...TREE, 'server/late.js': file('function later() { return require("./lib"); }', 'module.exports = { later };') }, ['tidy']);
  assert.deepEqual(late.dropped, []);
  assert.match(late.kept[0].why, /server\/late\.js:1 asks for server\/lib\.js from inside a function or a condition/);

  const noted = drop({ ...TREE, [OLD]: SOURCE.replace("const { clean }", "// Trims what the user typed.\nconst { clean }") }, ['tidy']);
  assert.deepEqual([noted.dropped, noted.kept], [[], [{ spec: './lib', why: 'the comment above it is about this require: a person decides' }]]);
  assert.deepEqual(noted.proof, []);

  const none = drop(TREE, ['plain']);
  assert.deepEqual([none.plan === none.plain, none.dropped, none.kept], [true, [], []], 'a step that leaves no such line asks nothing');
});

test('two lines of one step are judged one after the other, and what stood below a taken line is still found', (t) => {
  if (!parser) return t.skip(SKIP);
  const both = drop(TREE, ['tidy', 'shout']);
  assert.deepEqual(both.dropped, [{ spec: './lib', why: QUIET }]);
  assert.equal(both.kept[0].spec, './noisy');
  assert.deepEqual(both.proof, [], 'the line that stays and the new require moved up one line with the plan');
  assert.ok(!both.plan.newSource.includes("require('./lib')"));
  assert.ok(both.plan.newSource.includes("\nrequire('./noisy');\n"));

  // The same with the line that stays above the one that goes, and with both going.
  const swapped = SOURCE.replace("const { clean } = require('./lib');\nconst { other } = require('./noisy');", "const { other } = require('./noisy');\nconst { clean } = require('./lib');");
  const below = drop({ ...TREE, [OLD]: swapped }, ['tidy', 'shout']);
  assert.deepEqual([below.dropped.map((row) => row.spec), below.kept.map((row) => row.spec), below.proof], [['./lib'], ['./noisy'], []]);
  const calm = drop({ ...TREE, 'server/noisy.js': NOISY.replace('globalThis.loud = true;\n', '') }, ['tidy', 'shout']);
  assert.deepEqual([calm.dropped.map((row) => row.spec), calm.kept, calm.proof], [['./lib', './noisy'], [], []]);
  assert.ok(!/^require\(/m.test(calm.plan.newSource));
});

test('a line goes when an earlier line of the file already loads the same file, whatever that file runs', (t) => {
  if (!parser) return t.skip(SKIP);
  const hub = file("'use strict';", "const { other } = require('./noisy');", 'module.exports = { via: other };');
  const text = file("'use strict';", "const { via } = require('./hub');", "const { other } = require('./noisy');", '', 'function shout(a) { return other(a); }', '',
    'function run(a) { return via(a); }', '', 'module.exports = { run, shout };');
  const done = drop({ ...TREE, [OLD]: text, 'server/hub.js': hub }, ['shout']);
  assert.deepEqual(done.dropped, [{ spec: './noisy', why: 'line 2 loads server/hub.js, which always loads server/noisy.js first' }]);
  assert.deepEqual(done.proof, []);
});

test('a recorded step is redone as recorded: the same lines go, and one that is no longer proven is said', (t) => {
  if (!parser) return t.skip(SKIP);
  const free = drop(TREE, ['tidy', 'shout']);
  const again = drop(TREE, ['tidy', 'shout'], { only: ['./lib'] });
  assert.equal(again.plan.newSource, free.plan.newSource);
  assert.deepEqual([again.dropped, again.problems, again.proof], [free.dropped, [], []]);

  const calm = { ...TREE, 'server/noisy.js': NOISY.replace('globalThis.loud = true;\n', '') };
  const fewer = drop(calm, ['tidy', 'shout'], { only: ['./noisy'] });
  assert.deepEqual(fewer.dropped.map((row) => row.spec), ['./noisy'], 'a line that could go but was not recorded stays');
  assert.ok(fewer.plan.newSource.includes("\nrequire('./lib');\n"));
  assert.deepEqual(fewer.proof, []);

  const louder = drop(TREE, ['tidy', 'shout'], { only: ['./lib', './noisy'] });
  assert.equal(louder.problems.length, 1);
  assert.match(louder.problems[0], /^require\('\.\/noisy'\) is recorded as taken out, but it is not proven dead: server\/noisy\.js runs code when it loads/);
  assert.deepEqual(drop(TREE, ['tidy'], { only: ['./gone'] }).problems, ["require('./gone') is recorded as taken out, but the step leaves no such line"]);
  assert.deepEqual(drop(TREE, ['plain'], { only: ['./lib'] }).problems, ["require('./lib') is recorded as taken out, but the step leaves no such line"]);
});

const FACTORY = file("'use strict';", "const { clean } = require('./lib');", '', '// Builds the thing.', 'function createThing({ runner }) {',
  '  function find(name) { return runner(clean(name)); }', '', '  function fetchAll(names) { return names.map((name) => find(name)); }', '',
  '  return { fetchAll };', '}', '', 'module.exports = { createThing };');

test('functions taken out of a factory: the line goes, and the call of the new module is still where the plan says', (t) => {
  if (!parser) return t.skip(SKIP);
  const job = { parser, source: OLD, target: 'server/part/steps.js', factory: 'createThing', make: 'makeSteps' };
  const plain = planInner({ ...job, text: FACTORY, about: ABOUT, names: ['find', 'fetchAll'], rewrite });
  assert.ok(plain.newSource.includes("\nrequire('./lib');\n"));
  const tree = { [OLD]: FACTORY, 'server/lib.js': LIB };
  const done = dropDeadRequires({ plan: plain, source: OLD, target: job.target, parser, files: Object.keys(tree), read: (name) => tree[name] ?? null });
  assert.deepEqual(done.dropped, [{ spec: './lib', why: QUIET }]);
  assert.equal(done.plan.newSource, plain.newSource.replace("require('./lib');\n", ''));
  assert.deepEqual([done.plan.glue.sourceAt, done.plan.glue.bodyAt], [plain.glue.sourceAt - 1, plain.glue.bodyAt - 1]);
  assert.deepEqual(proveInner({ ...job, before: FACTORY, after: done.plan.newSource, moduleText: done.plan.moduleText, plan: done.plan }), []);
});

test('what a command prints about the lines of a step', () => {
  const bare = { dropped: [{ spec: './lib', why: 'A' }], kept: [{ spec: './noisy', why: 'B' }] };
  assert.deepEqual(bareLines(bare, false), ["  took out require('./lib'); the moved code was its last user and the line is proven dead: A.", "  left require('./noisy'); in its place: B."]);
  assert.deepEqual(bareLines(bare, true).map((line) => line.trim().split(' ').slice(0, 2).join(' ')), ['would take', 'would leave']);
  assert.deepEqual(bareLines(undefined, false), []);
});

test('extract and inner take the line on disk, record it, and verify redoes it and notices a file that started to run code', (t) => {
  if (!parser) return t.skip(SKIP);
  // A folder the map owns whole, so a new file in it has an owner on the day it is made.
  const at = (name) => `server/remote-control/${name}`;
  const root = mkdtempSync(join(tmpdir(), 'xenon-dead-requires-'));
  try {
    for (const folder of ['server/remote-control', 'server/test', 'tools/restructure', 'tools/map']) mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, 'tools/map/frozen-paths.json'), '{}\n');
    writeFileSync(join(root, PROTECTED), '{ "files": {} }\n');
    const put = (name, text) => writeFileSync(join(root, at(name)), text);
    const get = (name) => readFileSync(join(root, at(name)), 'utf8');
    for (const [name, text] of [['demo.js', SOURCE], ['old.js', SOURCE], ['lib.js', LIB], ['noisy.js', NOISY], ['thing.js', FACTORY]]) put(name, text);
    writeFileSync(join(root, 'server/test/late.js'), 'function later() { return require("../remote-control/lib"); }\n');
    assert.deepEqual(serverFilesOnDisk(root).sort(), ['demo.js', 'lib.js', 'noisy.js', 'old.js', 'thing.js'].map(at), 'tests are not the app');

    const job = { root, parser, source: at('demo.js'), target: at('demo-tidy.js'), about: ABOUT, names: ['tidy', 'shout'] };
    const tried = extract({ ...job, dryRun: true });
    assert.deepEqual(tried.bare.dropped.map((row) => row.spec), ['./lib']);
    assert.match(tried.bare.kept[0].why, /noisy\.js runs code when it loads/);
    assert.equal(get('demo.js'), SOURCE, 'a dry run writes nothing');
    assert.equal(existsSync(join(root, at('demo-tidy.js'))), false);

    assert.deepEqual(extract(job), tried);
    assert.ok(!get('demo.js').includes("require('./lib')"));
    assert.ok(get('demo.js').includes("\nrequire('./noisy');\n"));
    assert.deepEqual(readLedger(root).sources[at('demo.js')], [{ file: at('demo-tidy.js'), about: ABOUT, names: ['tidy', 'shout'], bare: ['./lib'] }]);
    const load = createRequire(join(root, 'server', 'x.js'));
    assert.deepEqual(load('./remote-control/demo.js').run(' a '), load('./remote-control/old.js').run(' a '), 'run for real, both give the same');

    const inner = moveInner({ root, parser, source: at('thing.js'), target: at('thing-steps.js'), about: ABOUT, factory: 'createThing', make: 'makeSteps', names: ['find', 'fetchAll'] });
    assert.deepEqual(inner.bare, { dropped: [{ spec: './lib', why: QUIET.replace('server/', 'server/remote-control/') }], kept: [] });
    assert.ok(!get('thing.js').includes("require('./lib')"));
    assert.deepEqual(readLedger(root).sources[at('thing.js')][0].bare, ['./lib']);
    assert.deepEqual(load('./remote-control/thing.js').createThing({ runner: (name) => name.length }).fetchAll([' a ', 'bb']), [1, 2]);

    const show = (_root, _rev, name) => ({ [at('demo.js')]: SOURCE, [at('thing.js')]: FACTORY })[name] ?? null;
    assert.deepEqual(replay({ root, parser, base: 'BASE', show }), { problems: [], replayed: 2,
      files: [[at('demo.js'), at('demo-tidy.js')], [at('thing.js'), at('thing-steps.js')]] });

    put('lib.js', LIB.replace("'use strict';\n", "'use strict';\nglobalThis.loud = true;\n"));
    const problems = replay({ root, parser, base: 'BASE', show }).problems.join('\n');
    assert.match(problems, /demo-tidy\.js: require\('\.\/lib'\) is recorded as taken out, but it is not proven dead: server\/remote-control\/lib\.js runs code when it loads/);
    assert.match(problems, /thing-steps\.js: require\('\.\/lib'\) is recorded as taken out, but it is not proven dead/);
    assert.match(problems, /demo\.js differs from BASE by more than the recorded moves/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
