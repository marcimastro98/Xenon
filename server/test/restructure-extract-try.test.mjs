// `remainder --movable` asks the planner (tools/restructure, extract-try.mjs): two declarations
// that each move alone are not listed as one step when `extract` would refuse them together,
// because the one new require cannot stand above the first use of both.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyze } from '../../tools/restructure/analyze.mjs';
import { movableSets, moveRefusal } from '../../tools/restructure/extract-try.mjs';
import { PROTECTED } from '../../tools/restructure/ledger.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { renderMovable } from '../../tools/restructure/remainder.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';
const file = (...lines) => `${lines.join('\n')}\n`;
const OLD = 'server/demo.js';

// `first` is used while the file loads (line 3), above the line that loads what `second` needs (line 4).
const SOURCE = file("const { early } = require('./a');", 'function first() { return early(); }', 'console.log(first());',
  "const { late } = require('./late');", 'function second() { return late(); }', 'function third() { return 3; }',
  'function user() { return second() + first() + third(); }');

function demoRepo() {
  const root = mkdtempSync(join(tmpdir(), 'xenon-extract-try-'));
  for (const folder of ['server', 'tools/restructure']) mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, PROTECTED), '{ "files": {} }\n');
  writeFileSync(join(root, OLD), SOURCE);
  writeFileSync(join(root, 'server/a.js'), file('function early() { return 1; }', 'module.exports = { early };'));
  writeFileSync(join(root, 'server/late.js'), file('function late() { return 2; }', 'module.exports = { late };'));
  return root;
}

test('each of two declarations moves alone, the two together are refused, and they are listed as two steps', (t) => {
  if (!parser) return t.skip(SKIP);
  const root = demoRepo();
  try {
    const analysis = analyze(SOURCE, parser, OLD);
    const refusal = moveRefusal({ root, text: SOURCE, source: OLD, analysis });
    assert.equal(refusal(['first']), null);
    assert.equal(refusal(['second']), null);
    assert.equal(refusal(['second', 'third']), null);
    assert.match(refusal(['first', 'second']), /loads at line 4, after line 3 where a moved name may already be used/);
    assert.match(refusal(['user']), /nothing left in server\/demo\.js uses user/);
    assert.equal(refusal(['first']), null, 'asking writes nothing and changes nothing: the same answer again');

    const records = analysis.records.filter((record) => ['first', 'second', 'third', 'user'].includes(record.names[0]));
    const { sets, alone } = movableSets(records, (record) => record.names, refusal);
    assert.deepEqual(sets.map((set) => set.map((record) => record.names[0])), [['first', 'third'], ['second']],
      'each goes into the first step that still moves with it in');
    assert.deepEqual(alone.map(({ item, reason }) => [item.names[0], /nothing left/.test(reason)]), [['user', true]]);

    const map = { ownerOfSpec: () => null, words: new Map() };
    const asked = renderMovable(analysis, map, refusal);
    assert.match(asked, /^engine-core: 3 declarations, 3 lines, in 2 steps: one new require cannot stand above the first use of all of them$/m);
    assert.match(asked, /  step 1: 2 declarations, 2 lines\n\s+2\s+1\s+first\n\s+6\s+1\s+third\n  step 2: 1 declarations, 1 lines\n\s+5\s+1\s+second/);
    assert.match(asked, /  not now: 7\s+1\s+user\n      user \(server\/demo\.js:7\) needs second \(line 5\), first \(line 2\), third \(line 6\) from server\/demo\.js.*; nothing left in server\/demo\.js uses user/);
    // Without the planner the list is what each declaration says of itself, as it was.
    assert.match(renderMovable(analysis, map), /^engine-core: 4 declarations, 4 lines\n\s+2\s+1\s+first\n\s+5\s+1\s+second\n\s+6\s+1\s+third\n\s+7\s+1\s+user$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a feature whose declarations all move in one step is listed as before', (t) => {
  if (!parser) return t.skip(SKIP);
  const root = demoRepo();
  try {
    const text = file('function one() { return 1; }', 'function two() { return 2; }', 'function user() { return one() + two(); }', 'module.exports = { user };');
    writeFileSync(join(root, OLD), text);
    const analysis = analyze(text, parser, OLD);
    const map = { ownerOfSpec: () => null, words: new Map(), kept: new Set(['user']) };
    const asked = renderMovable(analysis, map, moveRefusal({ root, text, source: OLD, analysis }));
    assert.equal(asked, renderMovable(analysis, map));
    assert.match(asked, /^engine-core: 2 declarations, 2 lines\n/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
