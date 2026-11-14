// The blank lines a move leaves behind (tools/restructure, extract-tidy.mjs): one at the end of
// the file when the last declaration leaves, two in a row when a require between blank lines is
// taken out. They go with the move, the proof accounts for each of them and refuses any other,
// `extract` records that it happened and `verify` redoes it; steps recorded before are redone as
// they were.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyze } from '../../tools/restructure/analyze.mjs';
import { dropDeadRequires } from '../../tools/restructure/dead-requires.mjs';
import { extract, replay } from '../../tools/restructure/extract.mjs';
import { planExtraction } from '../../tools/restructure/extract-plan.mjs';
import { tidyPlan } from '../../tools/restructure/extract-tidy.mjs';
import { LEDGER, PROTECTED, readLedger } from '../../tools/restructure/ledger.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { proveMove } from '../../tools/restructure/verify.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';
const file = (...lines) => `${lines.join('\n')}\n`;
const [OLD, NEW, ABOUT] = ['server/demo.js', 'server/part/x.js', 'What the part does.'];
const rewrite = (spec) => ({ spec: `.${spec}.js`, kind: 'file', file: `server/${spec.slice(2)}.js` });

const planOf = (text, names) => planExtraction({ text, analysis: analyze(text, parser, OLD), names, source: OLD, target: NEW, about: ABOUT, rewrite });
const proofOf = (text, plan) => proveMove({ before: text, after: plan.newSource, moduleText: plan.moduleText, plan });

// The last declaration of the file, used above it while the file loads: the require goes up there.
const LAST = file('const a = 1;', 'console.log(last());', '', '// The last one.', 'function last() { return 2; }');
// A require between two blank lines whose only user leaves, of a file that only declares.
const BETWEEN = file("'use strict';", "const SEP = '/';", '', "const { clean } = require('./lib');", '', 'function join(a) { return a + SEP; }', '',
  '// Cleans.', 'function tidy(a) { return clean(a); }', '', 'function run(a) { return join(tidy(a)); }', '', 'module.exports = { run };');
const LIB = file("'use strict';", 'function clean(a) { return String(a).trim(); }', 'module.exports = { clean };');

test('the last declaration leaves and the file does not end in a blank line', (t) => {
  if (!parser) return t.skip(SKIP);
  const plain = planOf(LAST, ['last']);
  assert.ok(plain.newSource.endsWith('console.log(last());\n\n'), 'the move alone leaves one');
  const tidy = tidyPlan(LAST, plain);
  assert.equal(tidy.newSource, file('const a = 1;', "const { last } = require('./part/x.js');", '', 'console.log(last());'));
  assert.deepEqual(tidy.glue.blanks, [5], 'the line after the last line break: taking it takes the blank line above it');
  assert.equal(tidy.moduleText, plain.moduleText);
  assert.deepEqual(proofOf(LAST, tidy), []);
  assert.ok(plain.newSource.endsWith('\n\n'), 'the plan that came in is not changed');
});

test('a require taken out from between two blank lines does not leave them as two in a row', (t) => {
  if (!parser) return t.skip(SKIP);
  const tree = { [OLD]: BETWEEN, 'server/lib.js': LIB };
  const { plan: bare, dropped } = dropDeadRequires({ plan: planOf(BETWEEN, ['tidy']), source: OLD, target: NEW, parser, files: Object.keys(tree), read: (name) => tree[name] ?? null });
  assert.deepEqual(dropped.map((row) => row.spec), ['./lib']);
  assert.ok(bare.newSource.includes("const SEP = '/';\n\n\nfunction join"), 'the move alone leaves two');
  const tidy = tidyPlan(BETWEEN, bare);
  assert.equal(tidy.newSource, file("'use strict';", "const SEP = '/';", '', 'function join(a) { return a + SEP; }', '',
    "const { tidy } = require('./part/x.js');", '', 'function run(a) { return join(tidy(a)); }', '', 'module.exports = { run };'));
  assert.deepEqual(tidy.glue.blanks, [4]);
  assert.deepEqual(proofOf(BETWEEN, tidy), []);
});

test('blank lines the move did not make stay, and a plan with nothing to tidy comes back as it is', (t) => {
  if (!parser) return t.skip(SKIP);
  const text = file('const a = 1;', '', '', 'function g() { return f() + a; }', 'function f() { return 1; }', '', '', 'const z = 2;');
  const plain = planOf(text, ['f']);
  assert.equal(tidyPlan(text, plain), plain);
  assert.ok(plain.newSource.startsWith('const a = 1;\n\n\nfunction g()'), 'two in a row that were there before are text nobody asked to change');
  // A plan made before the planner said where its parts stood in the old file: left alone.
  const { sourceFirst: _dropped, ...glue } = planOf(LAST, ['last']).glue;
  const older = { ...planOf(LAST, ['last']), glue };
  assert.equal(tidyPlan(LAST, older), older);
});

test('the proof refuses a line that went as blank and is not, one whose line above stayed, and one nobody listed', (t) => {
  if (!parser) return t.skip(SKIP);
  const tidy = tidyPlan(LAST, planOf(LAST, ['last']));
  const withBlanks = (blanks, newSource = tidy.newSource) => proofOf(LAST, { ...tidy, newSource, glue: { ...tidy.glue, blanks } }).join('\n');
  assert.match(withBlanks([1]), /line 2 of the old file went as a blank line, and it is not one/);
  assert.match(withBlanks([2]), /the blank line 3 of the old file went, but the line above it stayed/);
  assert.match(withBlanks([]), /lines are not accounted for/);
  // A blank line that stayed in the old file taken out too, without being listed.
  const more = tidy.newSource.replace("require('./part/x.js');\n\n", "require('./part/x.js');\n");
  assert.notEqual(more, tidy.newSource);
  assert.match(withBlanks([5], more), /lines are not accounted for|text outside the moved ranges changed/);
});

test('extract takes the blank line on disk and records it; verify redoes it, and a step recorded without it is redone as it was', (t) => {
  if (!parser) return t.skip(SKIP);
  // A folder the map owns whole, so a new file in it has an owner on the day it is made.
  const at = (name) => `server/remote-control/${name}`;
  const root = mkdtempSync(join(tmpdir(), 'xenon-extract-tidy-'));
  try {
    for (const folder of ['server/remote-control', 'tools/restructure', 'tools/map']) mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, 'tools/map/frozen-paths.json'), '{}\n');
    writeFileSync(join(root, PROTECTED), '{ "files": {} }\n');
    const get = (name) => readFileSync(join(root, at(name)), 'utf8');
    writeFileSync(join(root, at('demo.js')), BETWEEN);
    writeFileSync(join(root, at('lib.js')), LIB);

    extract({ root, parser, source: at('demo.js'), target: at('demo-tidy.js'), about: ABOUT, names: ['tidy'] });
    assert.ok(!/\n\n\n/.test(get('demo.js')), 'no two blank lines in a row');
    assert.ok(!get('demo.js').includes("require('./lib')"));
    assert.deepEqual(readLedger(root).sources[at('demo.js')], [{ file: at('demo-tidy.js'), about: ABOUT, names: ['tidy'], bare: ['./lib'], tidy: true }]);

    const show = (_root, _rev, name) => ({ [at('demo.js')]: BETWEEN })[name] ?? null;
    assert.deepEqual(replay({ root, parser, base: 'BASE', show }), { problems: [], replayed: 1, files: [[at('demo.js'), at('demo-tidy.js')]] });

    // The same step as the tool recorded it before it could tidy: the file on disk is then one blank line short.
    const ledger = join(root, LEDGER);
    writeFileSync(ledger, readFileSync(ledger, 'utf8').replace(',"tidy":true', ''));
    assert.ok(!('tidy' in readLedger(root).sources[at('demo.js')][0]));
    assert.match(replay({ root, parser, base: 'BASE', show }).problems.join('\n'), /demo\.js differs from BASE by more than the recorded moves/);
    writeFileSync(join(root, at('demo.js')), get('demo.js').replace("const SEP = '/';\n\n", "const SEP = '/';\n\n\n"));
    assert.deepEqual(replay({ root, parser, base: 'BASE', show }).problems, [], 'with the blank line back it is what the older tool wrote');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
