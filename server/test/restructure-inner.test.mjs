// Taking functions out of the body of a factory (tools/restructure, `inner`): the moved text is
// unchanged, the factory hands over what the functions used and takes them back under their
// names, the two files run like the one did, and whatever a hand-over would not keep is refused
// with a reason. The proof reads the texts on its own and catches a result that was changed.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { replay } from '../../tools/restructure/extract.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { moveInner } from '../../tools/restructure/inner.mjs';
import { planInner } from '../../tools/restructure/inner-plan.mjs';
import { proveInner } from '../../tools/restructure/inner-proof.mjs';
import { PROTECTED, readLedger } from '../../tools/restructure/ledger.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';
const SOURCE_FILE = 'server/demo.js';
const TARGET = 'server/part/steps.js';
const ABOUT = 'How a thing is fetched and counted.';
const file = (...lines) => [...lines, ''].join('\n');
// A require of a file is written as it is; a built-in gets `node:`.
const rewrite = (spec) => (spec.startsWith('.') ? { spec: `../${spec.slice(2)}`, kind: 'file', file: `server/${spec.slice(2)}` }
  : { spec: `node:${spec.replace(/^node:/, '')}`, kind: 'builtin', file: null });

function plan(text, names, more = {}) {
  return planInner({ text, parser, source: SOURCE_FILE, target: TARGET, about: ABOUT, factory: 'createThing', make: 'makeSteps', names, rewrite, ...more });
}
const refusal = (text, names, more) => {
  try { plan(text, names, more); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; }
  return '';
};
const proven = (text, made) => proveInner({ before: text, after: made.newSource, moduleText: made.moduleText, plan: made, parser,
  source: SOURCE_FILE, target: TARGET, factory: 'createThing', make: 'makeSteps' });

const SOURCE = file(
  "'use strict';",
  "const os = require('os');",
  "const { join } = require('path');",
  '',
  '// Builds the thing.',
  'function createThing({ runner, limit = 3 } = {}) {',
  '  const seen = new Map();',
  '  let calls = 0;',
  '',
  '  function count() { calls += 1; return calls; }',
  '',
  '  // Looks a name up once.',
  '  function find(name) {',
  '    if (!seen.has(name)) seen.set(name, runner(join(os.tmpdir(), name)));',
  '    return seen.get(name);',
  '  }',
  '',
  '  function fetchAll(names) {',
  '    return names.slice(0, limit).map((name) => find(name));',
  '  }',
  '',
  '  return { count, fetchAll, home: () => join(\'a\', \'b\') };',
  '}',
  '',
  'module.exports = { createThing };',
);

test('the functions go as they are, the factory hands over what they used and takes them back', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE, ['find', 'fetchAll']);
  assert.equal(made.newSource, file(
    "'use strict';",
    "const { join } = require('path');",
    '',
    "const { makeSteps } = require('./part/steps.js');",
    '',
    '// Builds the thing.',
    'function createThing({ runner, limit = 3 } = {}) {',
    '  const seen = new Map();',
    '  let calls = 0;',
    '',
    '  function count() { calls += 1; return calls; }',
    '',
    '  const { fetchAll } = makeSteps({ runner, limit, seen });',
    '',
    '  return { count, fetchAll, home: () => join(\'a\', \'b\') };',
    '}',
    '',
    'module.exports = { createThing };',
  ));
  assert.equal(made.moduleText, file(
    "'use strict';",
    '// How a thing is fetched and counted.',
    '',
    "const os = require('node:os');",
    "const { join } = require('node:path');",
    '',
    'function makeSteps({ runner, limit, seen }) {',
    '  // Looks a name up once.',
    '  function find(name) {',
    '    if (!seen.has(name)) seen.set(name, runner(join(os.tmpdir(), name)));',
    '    return seen.get(name);',
    '  }',
    '',
    '  function fetchAll(names) {',
    '    return names.slice(0, limit).map((name) => find(name));',
    '  }',
    '',
    '  return { fetchAll };',
    '}',
    '',
    'module.exports = { makeSteps };',
  ));
  assert.deepEqual(made.moved, ['find', 'fetchAll']);
  assert.deepEqual(made.returned, ['fetchAll'], 'find is used by nobody outside: it is not handed back');
  assert.deepEqual(made.passed, ['runner', 'limit', 'seen'], 'arguments first, then the constants of the body, in their order');
  assert.deepEqual(proven(SOURCE, made), []);
});

test('the two files run like the one did', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE, ['find', 'fetchAll']);
  const root = mkdtempSync(join(tmpdir(), 'xenon-inner-'));
  try {
    mkdirSync(join(root, 'part'));
    writeFileSync(join(root, 'old.js'), SOURCE);
    writeFileSync(join(root, 'demo.js'), made.newSource);
    writeFileSync(join(root, 'part', 'steps.js'), made.moduleText);
    const load = createRequire(join(root, 'x.js'));
    const run = (name) => {
      const asked = [];
      const thing = load(name).createThing({ runner: (place) => { asked.push(place); return place.length; }, limit: 2 });
      return { got: [thing.fetchAll(['a', 'bb', 'ccc']), thing.fetchAll(['a', 'bb']), thing.count(), thing.count()], asked };
    };
    assert.deepEqual(run('./demo.js'), run('./old.js'));
    assert.equal(run('./demo.js').asked.length, 2, 'the limit and the memory of what was looked up are the factory\'s own');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the call stands after the constants it hands over and before the first use while the factory runs', (t) => {
  if (!parser) return t.skip(SKIP);
  const text = file(
    'function createThing(runner) {',
    '  function first() { return table.size + runner(); }',
    '  const table = new Map();',
    '  const ready = first();',
    '  function second() { return first() + 1; }',
    '  return { ready, second };',
    '}',
    'module.exports = { createThing };',
  );
  const made = plan(text, ['first']);
  assert.deepEqual(made.newSource.split('\n').slice(3, 7), [
    '  const table = new Map();',
    '  const { first } = makeSteps({ runner, table });',
    '',
    '  const ready = first();',
  ]);
  assert.deepEqual(proven(text, made), []);
  const late = text.replace('  const table = new Map();\n  const ready = first();', '  const ready = first();\n  const table = new Map();');
  assert.match(refusal(late, ['first']), /table \(server\/demo\.js:4\) is declared after line 3, where createThing may already use a moved function/);
});

test('what a hand-over would not keep is refused, with the reason', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(refusal(SOURCE, ['count']), /count \(server\/demo\.js:10\) uses calls, a variable of createThing that can be assigned again/);
  assert.match(refusal(SOURCE, ['seen']), /seen is not a function declared once in the body of createThing/);
  assert.match(refusal(SOURCE, ['nowhere']), /nowhere is not a function declared once/);
  assert.match(refusal(SOURCE, ['find']), /^$/, 'find alone can go: fetchAll keeps using it');
  assert.match(refusal(SOURCE, ['find'], { make: 'createThing' }), /createThing is a word server\/demo\.js already uses/);
  assert.match(refusal(SOURCE, ['find'], { make: 'make steps' }), /--make needs the name/);
  assert.match(refusal(SOURCE, ['find'], { factory: 'other' }), /other is not a function declared at the top level/);
  assert.match(refusal(SOURCE, ['find'], { protectedNames: new Set(['createThing']) }), /security prelude/);
  const variants = [
    ['  function a() { return runner; }', '  runner = null;', /uses the argument runner, which createThing assigns again/],
    ['  function a() { return helper(); }', '', /uses helper, declared in server\/demo\.js itself \(line 1\).*Take helper out with extract first/s],
    ['  function a() { return __dirname; }', '', /uses __dirname, which would mean another file there/],
    ['  function a() { return eval("runner"); }', '', /uses eval/],
    ['  function a() { return 1; }', '  a = null;', /is assigned again in createThing/],
    ['  function a() { return createThing; }', '', /uses createThing, declared in server\/demo\.js itself/],
  ];
  for (const [declaration, extra, reason] of variants) {
    const text = file('function helper() { return 1; }', 'function createThing(runner) {', declaration, extra, '  return { a, runner };', '}', 'module.exports = { createThing, helper };');
    assert.match(refusal(text, ['a']), reason, declaration);
  }
  const dead = file('function createThing() {', '  function a() { return 1; }', '  return {};', '}', 'module.exports = { createThing };');
  assert.match(refusal(dead, ['a']), /nothing left in createThing uses a: delete dead code/);
  assert.match(refusal(SOURCE.replace('function createThing(', 'async function createThing('), ['find']), /is not a plain function/);
});

test('the proof catches a result that is not the plan', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE, ['find', 'fetchAll']);
  const check = (change) => proveInner({ before: SOURCE, after: made.newSource, moduleText: made.moduleText, plan: made, parser,
    source: SOURCE_FILE, target: TARGET, factory: 'createThing', make: 'makeSteps', ...change }).join('\n');
  assert.match(check({ moduleText: made.moduleText.replace('slice(0, limit)', 'slice(0, limit + 1)') }), /not in the new module unchanged/);
  assert.match(check({ after: made.newSource.replace('makeSteps({ runner, limit, seen })', 'makeSteps({ runner, limit: 9, seen })') }), /not where the plan put it/);
  assert.match(check({ moduleText: made.moduleText.replace("require('node:os')", "require('node:fs')") }), /os is not the same required name/);
  // A plan whose call hands over a variable, or stands after a use, does not prove itself.
  const renamed = { ...made, glue: { ...made.glue, bodyLines: ['  const { fetchAll } = makeSteps({ runner, limit, calls });', ''] } };
  const swapped = (text) => text.replace('makeSteps({ runner, limit, seen })', 'makeSteps({ runner, limit, calls })');
  assert.match(proveInner({ before: SOURCE, after: swapped(made.newSource), moduleText: made.moduleText.replace('function makeSteps({ runner, limit, seen })', 'function makeSteps({ runner, limit, calls })'),
    plan: renamed, parser, source: SOURCE_FILE, target: TARGET, factory: 'createThing', make: 'makeSteps' }).join('\n'), /seen meant something of server\/demo\.js and means nothing/);
  const early = file('function createThing(runner) {', '  function first() { return runner(); }', '  const ready = first();', '  return { ready, first };', '}');
  const moved = plan(early, ['first']);
  const lines = moved.newSource.split('\n');
  const at = lines.indexOf('  const ready = first();');
  const below = [...lines.slice(0, moved.glue.bodyAt), lines[at], ...moved.glue.bodyLines, ...lines.slice(at + 1)].join('\n');
  assert.match(proveInner({ before: early, after: below, moduleText: moved.moduleText, plan: { ...moved, glue: { ...moved.glue, bodyAt: moved.glue.bodyAt + 1 } },
    parser, source: SOURCE_FILE, target: TARGET, factory: 'createThing', make: 'makeSteps' }).join('\n'), /may use first before makeSteps has given the functions back/);
});

test('the command writes both files and records the step, a dry run writes nothing, and verify redoes it from the base', (t) => {
  if (!parser) return t.skip(SKIP);
  // A folder the map owns whole, so a new file in it has an owner on the day it is made.
  const [OLD, NEW] = ['server/remote-control/demo.js', 'server/remote-control/demo-steps.js'];
  const root = mkdtempSync(join(tmpdir(), 'xenon-inner-repo-'));
  try {
    for (const folder of ['server/remote-control', 'tools/restructure', 'tools/map']) mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, 'tools/map/frozen-paths.json'), '{}\n');
    writeFileSync(join(root, PROTECTED), '{ "files": {} }\n');
    writeFileSync(join(root, OLD), SOURCE);
    writeFileSync(join(root, 'server/remote-control/old.js'), SOURCE);
    const job = { root, parser, source: OLD, target: NEW, about: ABOUT, factory: 'createThing', make: 'makeSteps', names: ['find', 'fetchAll'] };

    const tried = moveInner({ ...job, dryRun: true });
    assert.deepEqual([tried.moved, tried.returned, tried.passed], [['find', 'fetchAll'], ['fetchAll'], ['runner', 'limit', 'seen']]);
    assert.throws(() => moveInner({ ...job, target: 'server/paired/demo-steps.js' }), Refusal, 'what leaves a file in a feature folder stays next to it');
    assert.throws(() => moveInner({ ...job, names: ['count'] }), Refusal);
    assert.equal(existsSync(join(root, NEW)), false, 'a dry run and a refusal write nothing');
    assert.equal(readFileSync(join(root, OLD), 'utf8'), SOURCE);
    assert.equal(existsSync(join(root, 'server/paired')), false);

    const done = moveInner(job);
    assert.deepEqual(done, { ...tried, target: NEW });
    assert.deepEqual(readLedger(root).sources, { [OLD]: [{ file: NEW, about: ABOUT, names: ['find', 'fetchAll'], inner: { factory: 'createThing', make: 'makeSteps' } }] });
    assert.match(readFileSync(join(root, OLD), 'utf8'), /\n {2}const \{ fetchAll \} = makeSteps\(\{ runner, limit, seen \}\);\n/);
    const load = createRequire(join(root, 'server', 'x.js'));
    const run = (name) => {
      const thing = load(name).createThing({ runner: (place) => place.length, limit: 2 });
      return [thing.fetchAll(['a', 'bb', 'ccc']), thing.count()];
    };
    assert.deepEqual(run('./remote-control/demo.js'), run('./remote-control/old.js'), 'run for real, both give the same');

    const show = (_root, _rev, name) => (name === OLD ? SOURCE : null);
    assert.deepEqual(replay({ root, parser, base: 'BASE', show }), { problems: [], replayed: 1, files: [[OLD, NEW]] });
    writeFileSync(join(root, NEW), readFileSync(join(root, NEW), 'utf8').replace('slice(0, limit)', 'slice(1, limit)'));
    assert.match(replay({ root, parser, base: 'BASE', show }).problems.join('\n'), /demo-steps\.js is not what the tool writes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
