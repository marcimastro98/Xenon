// Constants of a factory's body that leave it with the functions that use them (tools/restructure,
// `inner`, inner-constants.mjs): one whose value is written out moves, one the factory still uses
// comes back by the line that takes the functions back and is the same object on both sides, the
// ones only the moved code uses go along without being named, and every other is refused or left
// with a reason. The proof asks the same of the old file on its own.
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
const [SOURCE_FILE, TARGET, ABOUT] = ['server/demo.js', 'server/part/steps.js', 'How a thing is fetched.'];
const file = (...lines) => [...lines, ''].join('\n');
const rewrite = (spec) => (spec.startsWith('.') ? { spec: `../${spec.slice(2)}`, kind: 'file', file: `server/${spec.slice(2)}` }
  : { spec: `node:${spec.replace(/^node:/, '')}`, kind: 'builtin', file: null });
// The factory opens on line 4: its body starts on line 5.
const thing = (...body) => file("'use strict';", "const { sep } = require('path');", '', 'function createThing(runner, limit) {', ...body, '}', '', 'module.exports = { createThing };');

const plan = (text, names) => planInner({ text, parser, source: SOURCE_FILE, target: TARGET, about: ABOUT, factory: 'createThing', make: 'makeSteps', names, rewrite });
const refusal = (text, names) => {
  try { plan(text, names); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; }
  return '';
};
const proven = (before, made, moduleText = made.moduleText) => proveInner({ before, after: made.newSource, moduleText, plan: made, parser,
  source: SOURCE_FILE, target: TARGET, factory: 'createThing', make: 'makeSteps' });

const SOURCE = thing(
  '  // What was seen, by name.',
  '  const seen = new Map();',
  '  const LIMITS = { most: 3, wait: 2 * 1000 };',
  '  const pick = (list) => list.slice(0, LIMITS.most);',
  '',
  '  function find(name) {',
  '    if (!seen.has(name)) seen.set(name, runner(name));',
  '    return seen.get(name);',
  '  }',
  '',
  '  function fetchAll(names) { return pick(names).map(find); }',
  '',
  '  return { fetchAll, size: () => seen.size, wait: LIMITS.wait };',
);

test('a named constant moves with the functions, and one the factory still uses comes back by the same line', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE, ['find', 'fetchAll', 'seen', 'LIMITS', 'pick']);
  assert.deepEqual([made.moved, made.returned, made.passed], [['seen', 'LIMITS', 'pick', 'find', 'fetchAll'], ['seen', 'LIMITS', 'fetchAll'], ['runner']]);
  assert.equal(made.newSource, thing('  const { seen, LIMITS, fetchAll } = makeSteps({ runner });', '',
    '  return { fetchAll, size: () => seen.size, wait: LIMITS.wait };').replace("\n\nfunction createThing", "\n\nconst { makeSteps } = require('./part/steps.js');\n\nfunction createThing"));
  assert.equal(made.moduleText, file("'use strict';", '// How a thing is fetched.', '', 'function makeSteps({ runner }) {',
    '  // What was seen, by name.', '  const seen = new Map();', '  const LIMITS = { most: 3, wait: 2 * 1000 };', '  const pick = (list) => list.slice(0, LIMITS.most);', '',
    '  function find(name) {', '    if (!seen.has(name)) seen.set(name, runner(name));', '    return seen.get(name);', '  }', '',
    '  function fetchAll(names) { return pick(names).map(find); }', '', '  return { seen, LIMITS, fetchAll };', '}', '', 'module.exports = { makeSteps };'));
  assert.deepEqual(proven(SOURCE, made), []);
});

test('the constant handed back is the one object: what one side puts in it, the other finds', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE, ['find', 'fetchAll', 'seen', 'LIMITS', 'pick']);
  const root = mkdtempSync(join(tmpdir(), 'xenon-inner-const-run-'));
  try {
    mkdirSync(join(root, 'server', 'part'), { recursive: true });
    writeFileSync(join(root, 'server', 'old.js'), SOURCE);
    writeFileSync(join(root, SOURCE_FILE), made.newSource);
    writeFileSync(join(root, TARGET), made.moduleText);
    const load = createRequire(join(root, 'server', 'x.js'));
    const run = (name) => {
      const made = load(name).createThing((text) => text.length, 0);
      return [made.fetchAll(['a', 'bb', 'ccc', 'dddd']), made.size(), made.wait];
    };
    assert.deepEqual(run('./demo.js'), [[1, 2, 3], 3, 2000], 'the factory counts what the moved function put in the Map');
    assert.deepEqual(run('./demo.js'), run('./old.js'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a constant that is not a value written out, or that would read something else at another moment, is refused with the reason', (t) => {
  if (!parser) return t.skip(SKIP);
  const use = ['  function f() { return a; }', '  return { f };'];
  const variants = [
    [['  const a = runner();', ...use], ['a', 'f'], /a \(server\/demo\.js:5\) is not a value written out: it calls `runner\(\)`/],
    [['  const a = limit.most;', ...use], ['a', 'f'], /a \(server\/demo\.js:5\) is not a value written out: `limit\.most` is not a value written out/],
    [['  const { a } = { a: 1 };', ...use], ['a', 'f'], /is not a value written out: `\{ a \}` takes its names out of a value/],
    [['  const a = { get now() { return 1; } };', ...use], ['a', 'f'], /is a getter or a setter: it runs when the value is read/],
    [['  const a = () => this;', ...use], ['a', 'f'], /an arrow in it says `this`, which is createThing's/],
    [['  const a = () => arguments[0];', ...use], ['a', 'f'], /a \(server\/demo\.js:5\) says `arguments` in an arrow, which is createThing's/],
    [['  const a = [process];', ...use], ['a', 'f'], /reads process while createThing runs, a name no file declares: it could be another value at another moment/],
    [['  const a = limit * 2;', ...use], ['a', 'f'], /computes with limit or copies from it, an argument of createThing/],
    [['  const a = [...limit];', ...use], ['a', 'f'], /computes with limit or copies from it, an argument of createThing/],
    [['  const a = `${sep}x`;', ...use], ['a', 'f'], /computes with sep or copies from it, a required name/],
    [['  const base = 5;', '  const a = base * 2;', '  function f() { return a; }', '  return { f, base };'], ['a', 'f'],
      /a \(server\/demo\.js:6\) computes with base \(line 5\) or copies from it, and base stays in createThing: move it along, or leave a where it is/],
    [['  const a = [b];', '  const b = [];', ...use], ['a', 'b', 'f'], /a \(server\/demo\.js:5\) reads b above the line that declares it \(line 6\)/],
    [['  const list = [];', '  const a = list * 2;', ...use], ['list', 'a', 'f'], /computes with list \(line 5\), which is not a number or a string written out/],
    [['  function g() { return 1; }', '  const a = g + 1;', ...use], ['g', 'a', 'f'], /computes with the function g \(line 5\), or copies from it/],
    [['  const list = [1];', '  list.push(runner());', '  const a = [...list];', ...use], ['list', 'a', 'f'],
      /a \(server\/demo\.js:7\) copies what list \(line 5\) holds at that moment, and line 6 could change it first/],
    [['  const first = f();', '  const a = [];', ...use], ['a', 'f'], /a \(server\/demo\.js:6\): line 5 could use it while createThing runs, above the line that declares it: today that is an error/],
    [['  const a = [];', '  function reset() { a = null; }', '  function f() { return a; }', '  return { f, reset };'], ['a', 'f'], /is assigned to in createThing: a constant cannot be/],
    [['  let calls = 0;', '  const a = () => calls;', ...use], ['a', 'f'], /a \(server\/demo\.js:6\) uses calls, a variable of createThing that can be assigned again/],
    [['  const a = [], b = runner();', ...use], ['a', 'f'], /a, b \(server\/demo\.js:5\) is not a value written out: it calls `runner\(\)`/],
    [['  let a = [];', ...use], ['a', 'f'], /a is not a function declared once in the body of createThing, nor a constant/],
  ];
  for (const [body, names, reason] of variants) assert.match(refusal(thing(...body), names), reason, body[0]);
});

test('what a written-out constant may read: what moves with it above it, and what stays taken as it is', (t) => {
  if (!parser) return t.skip(SKIP);
  const body = ['  const KINDS = new Set([\'a\', \'b\']);', '  const HALF = 5;', '  const table = { size: HALF * 2, kinds: KINDS, all: [...KINDS], ask: runner, by: sep, last };',
    '  function last() { return table.size; }', '  function f() { return table; }', '  return { f, last };'];
  const made = plan(thing(...body), ['KINDS', 'HALF', 'table', 'f']);
  assert.deepEqual([made.moved, made.returned, made.passed], [['KINDS', 'HALF', 'table', 'f'], ['table', 'f'], ['runner', 'last']]);
  assert.match(made.moduleText, /^const \{ sep \} = require\('node:path'\);$/m, 'a required name read as it is comes with its require');
  assert.deepEqual(proven(thing(...body), made), []);
});

test('the proof asks the old file on its own whether a constant that left is written out', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE, ['find', 'fetchAll', 'seen', 'LIMITS', 'pick']);
  const swap = (text) => text.replace('new Map()', 'runner(sep)');
  assert.match(proven(swap(SOURCE), made, swap(made.moduleText)).join('\n'), /seen is not a value written out: it calls `runner\(\)`/);
  const lower = (text) => text.replace('const pick =', 'let pick =');
  assert.match(proven(lower(SOURCE), made, lower(made.moduleText)).join('\n'), /makeSteps is more than the moved functions and what it gives back/);
});

function demoRepo(source) {
  const root = mkdtempSync(join(tmpdir(), 'xenon-inner-const-repo-'));
  for (const folder of ['server/remote-control', 'tools/restructure', 'tools/map']) mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, 'tools/map/frozen-paths.json'), '{}\n');
  writeFileSync(join(root, PROTECTED), '{ "files": {} }\n');
  writeFileSync(join(root, 'server/remote-control/demo.js'), source);
  return root;
}
const [OLD, NEW] = ['server/remote-control/demo.js', 'server/remote-control/demo-steps.js'];

test('the constants only the moved code uses go along without being named; one the factory uses too is handed over, with the reason', (t) => {
  if (!parser) return t.skip(SKIP);
  const root = demoRepo(SOURCE);
  try {
    const job = { root, parser, source: OLD, target: NEW, about: ABOUT, factory: 'createThing', make: 'makeSteps', names: ['find', 'fetchAll'] };
    const tried = moveInner({ ...job, dryRun: true });
    assert.deepEqual([tried.moved, tried.returned, tried.passed], [['pick', 'find', 'fetchAll'], ['fetchAll'], ['runner', 'seen', 'LIMITS']]);
    assert.deepEqual(tried.along.added, ['pick']);
    assert.deepEqual(tried.along.left.map((row) => row.name).sort(), ['LIMITS', 'seen']);
    for (const row of tried.along.left) assert.match(row.why, /^line 17 of createThing uses it too: it is handed over; name it to move it and have it handed back$/);
    assert.deepEqual(tried.along.left.map((row) => row.shared), [true, true], 'marked as shared, so the command tells them in one line');
    assert.equal(existsSync(join(root, NEW)), false, 'a dry run writes nothing');

    const done = moveInner({ ...job, names: ['find', 'fetchAll', 'seen'] });
    assert.deepEqual([done.moved, done.returned, done.passed, done.along.added], [['seen', 'pick', 'find', 'fetchAll'], ['seen', 'fetchAll'], ['runner', 'LIMITS'], ['pick']]);
    assert.deepEqual(readLedger(root).sources[OLD][0].names, ['seen', 'pick', 'find', 'fetchAll'], 'the step records every name that left');
    assert.match(readFileSync(join(root, OLD), 'utf8'), /\n {2}const \{ seen, fetchAll \} = makeSteps\(\{ runner, LIMITS \}\);\n/);
    const show = (_root, _rev, name) => (name === OLD ? SOURCE : null);
    assert.deepEqual(replay({ root, parser, base: 'BASE', show }), { problems: [], replayed: 1, files: [[OLD, NEW]] }, 'redone from the names it recorded, it adds none');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a constant that stays keeps the one that computes with it, and the function is handed that one as before', (t) => {
  if (!parser) return t.skip(SKIP);
  const source = thing('  const base = 5;', '  const twice = base * 2;', '  const lone = [twice];', '  function f() { return lone.length + twice; }', '  return { f, base };');
  const root = demoRepo(source);
  try {
    const tried = moveInner({ root, parser, source: OLD, target: NEW, about: ABOUT, factory: 'createThing', make: 'makeSteps', names: ['f'], dryRun: true });
    assert.deepEqual([tried.moved, tried.passed, tried.along.added], [['lone', 'f'], ['twice'], ['lone']], 'lone only takes twice as it is: it goes, and is handed twice');
    assert.deepEqual(tried.along.left.map((row) => row.name), ['twice'], 'base, which nothing that moves uses, is not told');
    assert.match(tried.along.left[0].why, /computes with base \(line 5\) or copies from it, and base stays in createThing/);
    assert.equal(tried.along.left[0].shared, false);

    // A constant left behind can be what the move then trips on: the refusal says both.
    writeFileSync(join(root, OLD), thing('  const first = runner(f);', '  const a = [];', '  function f() { return a; }', '  return { f, first };'));
    assert.throws(() => moveInner({ root, parser, source: OLD, target: NEW, about: ABOUT, factory: 'createThing', make: 'makeSteps', names: ['f'], dryRun: true }),
      (error) => error instanceof Refusal && /a \(.*:6\) is declared after line 5/.test(error.reasons[0])
        && /^a was left in createThing: a \(.*:6\): line 5 could use it while createThing runs, above the line that declares it/.test(error.reasons.at(-1)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
