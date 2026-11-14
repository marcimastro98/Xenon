// Gathering what a factory remembers into one object (tools/restructure, `gather`): every use of
// the factory's own variable becomes a property, a parameter or a local of the same name stays
// what it was, a first value that needs something stays on its line, the code runs like before,
// and whatever could change what runs, or when it fails, is refused with a reason.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { planGather } from '../../tools/restructure/gather-plan.mjs';
import { proveGather } from '../../tools/restructure/gather-proof.mjs';
import { undoGatherNames, undoGatherText } from '../../tools/restructure/gather-undo.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { oldNames } from './engine-source.mjs';
import { GATHERED, SOURCE, file, useThing } from './restructure-gather-fixture.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';
const SOURCE_FILE = 'server/demo.js';

const plan = (text, more = {}) => planGather({ text, parser, source: SOURCE_FILE, factory: 'createThing', object: 'memory', ...more });
const refusal = (text, more) => {
  try { plan(text, more); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; }
  return '';
};
const proven = (text, made, change = {}) => proveGather({ before: text, after: made.newSource, plan: made, parser, source: SOURCE_FILE, ...change }).join('\n');
// A factory with these lines as its body.
const thing = (...body) => file("'use strict';", 'function createThing(runner) {', ...body, '}', 'module.exports = { createThing };');

test('every use of the factory\'s own variable becomes a property, and the same word that means something else stays', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE);
  assert.equal(made.newSource, GATHERED);
  assert.deepEqual([made.names, made.kept, made.bare], [['calls', 'last', 'label', 'budget', 'twice'], ['budget', 'twice'], ['last']]);
  assert.deepEqual(made.counts.label, { found: 5, shorthand: 3, moved: true }, '{ label } is written out three times: read, read and assigned');
  assert.deepEqual(made.counts.budget, { found: 4, shorthand: 0, moved: false }, 'its first value needs an argument: it stays on its line');
  assert.equal(proven(SOURCE, made), '');
  const record = { object: 'memory', names: made.names, kept: made.kept, bare: made.bare };
  assert.equal(undoGatherText(made.newSource, record), SOURCE, 'read back as text, the lets and their names are there again');
  assert.equal(oldNames(made.newSource, [], [record]), SOURCE, 'which is what a test reading the engine as text is handed');
  assert.equal(undoGatherNames('  function count() { memory.calls += 1; return { label: memory.label }; }', record), '  function count() { calls += 1; return { label }; }');
});

test('the rewritten factory runs like the old one', (t) => {
  if (!parser) return t.skip(SKIP);
  const root = mkdtempSync(join(tmpdir(), 'xenon-gather-'));
  try {
    writeFileSync(join(root, 'old.js'), SOURCE);
    writeFileSync(join(root, 'new.js'), plan(SOURCE).newSource);
    const load = createRequire(join(root, 'x.js'));
    const [was, is] = [useThing(load('./old.js').createThing), useThing(load('./new.js').createThing)];
    assert.deepEqual(is, was);
    assert.deepEqual(was.slice(0, 5), [1, { last: 'a', label: 'a:1', size: 0, own: 'none' }, 10, 1, 'string'], 'and the old one does what the test thinks it does');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('some of the variables can be named, and a let that stands after the functions using it can go', (t) => {
  if (!parser) return t.skip(SKIP);
  const some = plan(SOURCE, { names: ['label', 'calls'] });
  assert.deepEqual(some.names, ['calls', 'label'], 'in the order they are declared');
  assert.match(some.newSource, /\n {2}let last;\n/);
  assert.match(some.newSource, /function kind\(\) \{ return typeof last; \}/);
  assert.equal(proven(SOURCE, some), '');
  const text = thing('  function count() { calls += 1; return calls + step; }', '  let calls = 0;', '', '  // How far one call goes.', '  let step = [1, 2].length;',
    '  return { count };');
  const made = plan(text);
  assert.deepEqual(made.newSource.split('\n').slice(2, 10), [
    '  function count() { memory.calls += 1; return memory.calls + memory.step; }',
    '  const memory = {',
    '    calls: 0,',
    '    // How far one call goes.',
    '    step: [1, 2].length,',
    '  };',
    '',
    '  return { count };',
  ]);
  assert.equal(proven(text, made), '');
  assert.deepEqual(plan(thing('  let a = 0;', '  const b = runner(1);', '  let c = 2;', '  return () => a + b + c;')).between, [4], 'a line that calls something, for a person to read');
});

test('what could change what runs, or when it fails, is refused with the reason', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(refusal(SOURCE.replaceAll('\n', '\r\n')), /Windows line endings/);
  assert.match(refusal(SOURCE, { object: 'the memory' }), /cannot be the name of the object/);
  assert.match(refusal(SOURCE, { object: 'process' }), /cannot be the name of the object/);
  assert.match(refusal(SOURCE, { object: 'seen' }), /seen is a word server\/demo\.js already has/);
  assert.match(refusal(SOURCE, { object: 'thing' }), /thing is a word server\/demo\.js already has/, 'a comment counts: the undo reads text');
  assert.match(refusal(SOURCE, { factory: 'other' }), /other is not a function declared at the top level/);
  assert.match(refusal(SOURCE, { protectedNames: new Set(['createThing']) }), /security prelude/);
  assert.match(refusal(SOURCE, { names: ['seen'] }), /seen \(server\/demo\.js:5\) is a const, not a let/);
  assert.match(refusal(SOURCE, { names: ['count'] }), /count \(server\/demo\.js:11\) is a function, not a let/);
  assert.match(refusal(SOURCE, { names: ['nowhere'] }), /nowhere is not declared in the body of createThing/);
  assert.match(refusal(SOURCE, { names: ['calls', 'calls'] }), /a variable is named twice/);
  assert.match(refusal(thing('  const a = 1;', '  return a;')), /declares no let in its body: there is nothing to gather/);
  const variants = [
    [['  var a = 0;', '  return () => a;'], /a \(server\/demo\.js:3\) is a var: it exists, holding nothing, from the first line of createThing/],
    [['  let a = 0, b = 1;', '  return () => a + b;'], /is declared together with other names/],
    [['  let { a } = runner;', '  return () => a;'], /is declared together with other names/],
    [['  let a = 0; let b = 1;', '  return () => a + b;'], /shares a line with another statement/],
    [['  let  a = 0;', '  return () => a;'], /is not written as `let name` at the start of a line of the body/],
    [['  let a /* later */;', '  return () => a;'], /has no first value and is not on one plain line/],
    [['  let a = () => 1;', '  return () => a;'], /holds a function without a name of its own/],
    [['  let a = null;', '  function set() { a = function () {}; }', '  return set;'], /a \(server\/demo\.js:4\) is given a function without a name of its own/],
    [['  let a = null;', '  function set(o) { ({ a = () => 1 } = o); }', '  return set;'], /is given a function without a name of its own/],
    [['  let a = null;', '  return () => a();'], /a \(server\/demo\.js:4\) is called: as memory\.a\(\) the function would get memory as `this`/],
    [['  let a = 0;', '  return () => ({ a /* now */ });'], /something stands between the short `\{ a \}` and the comma, the \} or the first value after it/],
    [['  let a = runner();', '  a = 2;', '  return () => a;'], /is assigned by a statement that starts a line of a body/],
    // Text for the tool to refuse: nothing here is run.
    [['  let a = 0;', '  return () => eval(\'a\');'], /createThing calls eval, which could name a variable in text no tool can see/],
    // A later let used to stop the factory when it was read before its line; as a property it would read as nothing.
    [['  let a = 0;', '  function peek() { return b; }', '  const early = peek();', '  let b = 1;', '  return () => a + b + early;'],
      /b \(server\/demo\.js:6\): the statement at line 5 runs before that line and can reach it/],
    [['  let a = 0;', '  const early = () => b;', '  let b = runner();', '  return () => a + b + early();'], /b \(server\/demo\.js:5\): the statement at line 4 runs before that line/],
    [['  let a = runner(() => a);', '  return () => a;'], /a \(server\/demo\.js:3\): working out its first value can reach a itself/],
    [['  function peek() { return a; }', '  let a = runner(peek);', '  return () => a;'], /a \(server\/demo\.js:4\): working out its first value can reach a itself/],
  ];
  for (const [body, reason] of variants) assert.match(refusal(thing(...body)), reason, body.join(' '));
  const loose = (...body) => file('function createThing(runner) {', ...body, '}');
  assert.match(refusal(loose('  let a = 0;', '  with (runner) { a += 1; }', '  return a;')), /has a with statement, which hides where a name comes from/);
  assert.match(refusal(loose('  let a = 0;', '  return () => delete a;')), /a \(server\/demo\.js:3\) is the operand of delete/);
  assert.equal(refusal(thing('  let a = 0;', '  function peek() { return b; }', '  let b = 1;', '  return () => a + b + peek();')), '', 'a function declared in between runs nothing');
});

test('the proof reads the scopes on its own and catches a result that was changed', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE);
  const swapped = (from, to) => ({ after: made.newSource.replace(from, to) });
  assert.match(proven(SOURCE, made, swapped('function shadow(calls) { const label = calls * 2;', 'function shadow(calls) { const label = memory.calls * 2;')),
    /calls at line 14 of server\/demo\.js was rewritten and is not createThing's own variable: another one has its name there/);
  assert.match(proven(SOURCE, made, swapped('return typeof memory.last;', 'return typeof last;')), /last at line 16 of server\/demo\.js is createThing's own and was not rewritten/);
  assert.match(proven(SOURCE, made, swapped('    last: for (;;)', '    memory.last: for (;;)')), /rewritten and is not createThing's own variable/);
  assert.match(proven(SOURCE, made, swapped('memory.calls += 1', 'memory.calls += 2')), /does not give the old file back byte for byte/);
  assert.match(proven(SOURCE, made, swapped('    calls: 0,', '    calls: 1,')), /the object is not where the plan put it/);
  // A plan that says of itself what the changed text shows does not prove itself either.
  const rows = made.glue.lines.map((row) => row.replace('calls: 0,', 'calls: 1,'));
  assert.match(proven(SOURCE, { ...made, glue: { ...made.glue, lines: rows } }, swapped('    calls: 0,', '    calls: 1,')), /the object does not hold exactly the first values that left their lines/);
  const short = { ...made, names: made.names.filter((name) => name !== 'twice'), kept: ['budget'] };
  assert.match(proven(SOURCE, short), /does not give the old file back byte for byte/);
});
