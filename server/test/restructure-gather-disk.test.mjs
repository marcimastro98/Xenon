// The `gather` command on disk (tools/restructure): it writes the file and records the step, a dry
// run and a refusal write nothing, `verify` redoes the step from the base, and a function that
// reads only the gathered object can then leave the factory with `inner`, which a `let` forbade.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { replay } from '../../tools/restructure/extract.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { gather } from '../../tools/restructure/gather.mjs';
import { undoGatherNames } from '../../tools/restructure/gather-undo.mjs';
import { moveInner } from '../../tools/restructure/inner.mjs';
import { LEDGER, PROTECTED, readLedger } from '../../tools/restructure/ledger.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { GATHERED, SOURCE, useThing } from './restructure-gather-fixture.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';
// A folder the map owns whole, so a new file in it has an owner on the day it is made.
const [OLD, NEW, COPY] = ['server/remote-control/demo.js', 'server/remote-control/demo-counting.js', 'server/remote-control/old.js'];
const ABOUT = 'How the thing counts what it was asked.';

// A repo in a temp folder with the factory in it, removed when the test ends.
function repoWith(t) {
  const root = mkdtempSync(join(tmpdir(), 'xenon-gather-repo-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const folder of ['server/remote-control', 'tools/restructure', 'tools/map']) mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, 'tools/map/frozen-paths.json'), '{}\n');
  writeFileSync(join(root, PROTECTED), '{ "files": {} }\n');
  writeFileSync(join(root, OLD), SOURCE);
  writeFileSync(join(root, COPY), SOURCE);
  const read = (name) => readFileSync(join(root, name), 'utf8');
  const load = createRequire(join(root, 'server', 'x.js'));
  return { root, read, run: (name) => useThing(load(name.replace('server/', './')).createThing) };
}
const atBase = (_root, _rev, name) => (name === OLD ? SOURCE : null);

test('the command writes the file and records the step, a dry run and a refusal write nothing, and verify redoes it', (t) => {
  if (!parser) return t.skip(SKIP);
  const { root, read, run } = repoWith(t);
  const job = { root, parser, source: OLD, factory: 'createThing', object: 'memory' };

  const tried = gather({ ...job, dryRun: true });
  assert.deepEqual([tried.names, tried.kept, tried.sourceLines], [['calls', 'last', 'label', 'budget', 'twice'], ['budget', 'twice'], 4]);
  assert.throws(() => gather({ ...job, object: 'seen' }), Refusal);
  assert.throws(() => gather({ ...job, names: ['seen'] }), Refusal);
  assert.equal(read(OLD), SOURCE, 'a dry run and a refusal write nothing');
  assert.deepEqual(readLedger(root).gathers, undefined);

  assert.deepEqual(gather(job), tried);
  assert.equal(read(OLD), GATHERED);
  assert.deepEqual(readLedger(root).gathers, { [OLD]: [{ factory: 'createThing', object: 'memory', names: tried.names, kept: ['budget', 'twice'], bare: ['last'], after: 0 }] });
  assert.deepEqual(run(OLD), run(COPY), 'run for real, both give the same');
  assert.throws(() => gather({ ...job, object: 'more' }), /declares no let in its body/, 'nothing is left to gather');

  assert.deepEqual(replay({ root, parser, base: 'BASE', show: atBase }), { problems: [], replayed: 1, files: [[OLD]] });
  // The revision that has the step in its own list has it in its file too: nothing is redone on top of it.
  const withStep = (_root, _rev, name) => (name === OLD ? GATHERED : name === LEDGER ? read(LEDGER) : null);
  assert.deepEqual(replay({ root, parser, base: 'NEXT', show: withStep }), { problems: [], replayed: 0, files: [[OLD]] });
  writeFileSync(join(root, OLD), GATHERED.replace('memory.calls += 1', 'memory.calls += 2'));
  assert.match(replay({ root, parser, base: 'BASE', show: atBase }).problems.join('\n'), /demo\.js differs from BASE by more than the recorded moves/);
  writeFileSync(join(root, OLD), GATHERED);
  const ledger = read(LEDGER);
  writeFileSync(join(root, LEDGER), ledger.replace('"kept":["budget","twice"]', '"kept":["budget"]'));
  assert.notEqual(read(LEDGER), ledger, 'the list is written the way the test thinks');
  assert.match(replay({ root, parser, base: 'BASE', show: atBase }).problems.join('\n'), /memory of createThing: the recorded gather is not the one the tool makes from BASE/);
});

test('a file with a cut object or route bodies recorded is refused: the order could not be redone', (t) => {
  if (!parser) return t.skip(SKIP);
  const { root, read } = repoWith(t);
  writeFileSync(join(root, LEDGER), `${JSON.stringify({ sources: {}, branches: { [OLD]: [] } })}\n`);
  assert.throws(() => gather({ root, parser, source: OLD, factory: 'createThing', object: 'memory' }), /demo\.js has branches recorded/);
  assert.equal(read(OLD), SOURCE);
});

test('a function that reads only the gathered object can leave the factory, and verify redoes both steps in their order', (t) => {
  if (!parser) return t.skip(SKIP);
  const { root, read, run } = repoWith(t);
  const move = { root, parser, source: OLD, target: NEW, about: ABOUT, factory: 'createThing', make: 'makeCounting', names: ['count', 'kind', 'later'] };
  assert.throws(() => moveInner({ ...move, dryRun: true }), /count \(server\/remote-control\/demo\.js:11\) uses calls, a variable of createThing that can be assigned again/);

  gather({ root, parser, source: OLD, factory: 'createThing', object: 'memory' });
  const done = moveInner(move);
  assert.deepEqual([done.moved, done.returned, done.passed], [['count', 'later', 'kind'], ['count', 'later', 'kind'], ['memory']]);
  assert.match(read(OLD), /\n {2}const \{ count, later, kind \} = makeCounting\(\{ memory \}\);\n/);
  assert.match(read(NEW), /\n {2}function count\(\) \{ memory\.calls \+= 1; return memory\.calls; \}\n/);
  assert.equal(readLedger(root).gathers[OLD][0].after, 0);
  assert.deepEqual(readLedger(root).sources[OLD].map((entry) => entry.file), [NEW]);
  assert.deepEqual(run(OLD), run(COPY), 'the factory and its new module still answer like the one file did');
  // A test that reads the module as text finds the old names in it.
  const record = readLedger(root).gathers[OLD][0];
  assert.match(undoGatherNames(read(NEW), record), /\n {2}function count\(\) \{ calls \+= 1; return calls; \}\n/);

  assert.deepEqual(replay({ root, parser, base: 'BASE', show: atBase }), { problems: [], replayed: 2, files: [[OLD, NEW]] });
  // Redone the other way round the move is refused, so the order in the list is the order that is proven.
  const ledger = read(LEDGER);
  writeFileSync(join(root, LEDGER), ledger.replace('"after":0', '"after":1'));
  assert.notEqual(read(LEDGER), ledger);
  assert.match(replay({ root, parser, base: 'BASE', show: atBase }).problems.join('\n'), /demo-counting\.js: the recorded move cannot be redone from BASE/);
});
