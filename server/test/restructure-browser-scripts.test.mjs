// Taking declarations out of a classic browser script (tools/restructure,
// `browser extract`): the moved lines are the same lines, the old script loses
// exactly those, and what would change how the page runs is refused with a reason.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeRun, orderProblems, stayReasons } from '../../tools/restructure/browser-analyze.mjs';
import { planScriptMove, proveScriptMove, resolvePicks } from '../../tools/restructure/browser-plan.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const OLD = 'server/js/demo.js';
const NEW = 'server/js/demo/part.js';
const plan = (text, names, earlier = []) => planScriptMove({ scripts: [...earlier, { file: OLD, text }], target: NEW,
  about: 'What the part does.', names, parser });
const refusal = (text, names, earlier) => {
  try { plan(text, names, earlier); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; }
  return '';
};

const SOURCE = ["'use strict';", '', 'const LIMIT = 3;', 'let seen = 0;', '',
  '// ── Counting ──', '', '// Adds one.', 'function count() {', '  seen += 1;', '  return seen < LIMIT;', '}', 'window.count = count;', '',
  'const DOUBLE = LIMIT * 2;', 'count();', "document.addEventListener('click', count);", ''].join('\n');

test('a function moves with its comments and its window line, and the old script loses only those lines', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE, ['seen', 'count']);
  assert.equal(made.targetText, ['// What the part does.', "'use strict';", '', 'let seen = 0;', '',
    '// ── Counting ──', '', '// Adds one.', 'function count() {', '  seen += 1;', '  return seen < LIMIT;', '}', 'window.count = count;', ''].join('\n'));
  assert.equal(made.newSource, ["'use strict';", '', 'const LIMIT = 3;', '',
    'const DOUBLE = LIMIT * 2;', 'count();', "document.addEventListener('click', count);", ''].join('\n'));
  assert.deepEqual(made.moved, ['seen', 'count']);
});

test('the proof is separate from the plan and catches a line changed on the way', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE, ['seen', 'count']);
  const before = [{ file: OLD, text: SOURCE }];
  const after = (target, source) => [{ file: NEW, text: target }, { file: OLD, text: source }];
  assert.deepEqual(proveScriptMove({ before, after: after(made.targetText, made.newSource), plan: made, parser }), []);
  const edited = made.targetText.replace('seen < LIMIT', 'seen <= LIMIT');
  assert.match(proveScriptMove({ before, after: after(edited, made.newSource), plan: made, parser }).join('\n'), /is not the moved lines, unchanged/);
  const lost = made.newSource.replace('count();\n', '');
  assert.match(proveScriptMove({ before, after: after(made.targetText, lost), plan: made, parser }).join('\n'), /changed outside the moved lines/);
});

test('code that runs while the page loads keeps its place', (t) => {
  if (!parser) return t.skip(SKIP);
  const run = analyzeRun([{ file: OLD, text: SOURCE }], parser);
  const why = (index) => stayReasons(run.records[index], run).join('\n');
  const at = (text) => run.records.findIndex((record) => SOURCE.split('\n')[record.line[0] - 1].startsWith(text));
  assert.match(why(at('count();')), /runs when the script loads/);
  assert.match(why(at('document.addEventListener')), /runs when the script loads/);
  assert.equal(why(at('window.count = count;')), '', 'a function is on window under its own name already: the line repeats it');
  assert.equal(why(at('function count')), '');
});

test('window.name = name stays when it is not a plain repeat', (t) => {
  if (!parser) return t.skip(SKIP);
  const text = ['function a() {}', 'window.a = a;', 'const B = 1;', 'window.B = B;', 'function c() {}', 'window.other = c;',
    'function d() {}', 'window.d = d;', 'd = null;', ''].join('\n');
  const run = analyzeRun([{ file: OLD, text }], parser);
  assert.deepEqual(run.records.map((record) => record.echo), [null, 'a', null, null, null, null, null, null, null],
    'only a function nothing assigns, handed over under its own name');
});

test('a const moves only when everything its first value needs is already there', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.deepEqual(plan(SOURCE, ['LIMIT', 'DOUBLE']).moved, ['LIMIT', 'DOUBLE']);
  assert.match(refusal(SOURCE, ['DOUBLE']), /DOUBLE \(server\/js\/demo\/part\.js\) reads LIMIT for its first value, and LIMIT is declared after it/);
  const state = ['let seen = 0;', 'function bump() { seen += 1; }', 'const START = seen;', ''].join('\n');
  assert.match(refusal(state, ['START']), /reads seen for its first value, and seen changes while the page runs/);
  const outside = ['const NOW = Shared.clock;', 'function f() { return NOW; }', ''].join('\n');
  assert.match(refusal(outside, ['NOW']), /runs code to get its first value|which another script provides/);
  const called = ['function make() { return 1; }', 'const MADE = make();', ''].join('\n');
  assert.match(refusal(called, ['MADE']), /runs code to get its first value/);
});

test('a let stays in one script with code that assigns it', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(refusal(SOURCE, ['seen']), /seen would be in server\/js\/demo\/part\.js with nothing there that assigns it: keep it in one script with count/);
  assert.match(refusal(SOURCE, ['count']), /seen would be in server\/js\/demo\.js with nothing there that assigns it/);
  const two = ['let n = 0;', 'function up() { n += 1; }', 'function down() { n -= 1; }', ''].join('\n');
  assert.deepEqual(plan(two, ['up']).moved, ['up'], 'one writer stays behind with the let');
  assert.match(refusal(plan(two, ['up']).newSource, ['down'], [{ file: 'server/js/demo/first.js', text: plan(two, ['up']).targetText }]),
    /n would be in server\/js\/demo\.js with nothing there that assigns it/);
  assert.deepEqual(plan(two, ['n', 'up']).moved, ['n', 'up']);
});

test('what cannot be told apart safely is refused', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(refusal(SOURCE, ['nothing']), /declares no nothing at its top level/);
  assert.match(refusal('function a() {} function b() {}\n', ['a']), /shares a line with another statement/);
  assert.match(refusal('var old = 1;\nfunction f() { return old; }\n', ['old']), /only functions, const, let and classes move/);
  const long = `${Array.from({ length: 305 }, (_, i) => `function f${i}() {}`).join('\n')}\n`;
  assert.match(refusal(long, Array.from({ length: 305 }, (_, i) => `f${i}`)), /would be 30\d lines: a new file stays within 300/);
});

test('a script taken out earlier is part of the picture', (t) => {
  if (!parser) return t.skip(SKIP);
  const first = plan(SOURCE, ['LIMIT']);
  const earlier = [{ file: 'server/js/demo/first.js', text: first.targetText }];
  assert.deepEqual(plan(first.newSource, ['DOUBLE'], earlier).moved, ['DOUBLE'], 'LIMIT is in a script that loads before');
  const run = analyzeRun([...earlier, { file: OLD, text: first.newSource }], parser);
  assert.deepEqual(orderProblems(run), []);
  assert.deepEqual([...run.duplicates], []);
});

test('a pick is a name or a range, and a range skips what stays', (t) => {
  if (!parser) return t.skip(SKIP);
  const run = analyzeRun([{ file: OLD, text: SOURCE }], parser);
  const mayMove = (record) => stayReasons(record, run).length === 0;
  assert.deepEqual(resolvePicks(run.records, ['LIMIT..DOUBLE'], mayMove).names, ['LIMIT', 'seen', 'count', 'DOUBLE']);
  assert.deepEqual(resolvePicks(run.records, ['count'], mayMove).names, ['count']);
  assert.deepEqual(resolvePicks(run.records, ['DOUBLE..LIMIT', 'gone'], mayMove).unknown, ['DOUBLE..LIMIT', 'gone']);
});
