// The proof of a move of functions out of a browser script's wrapper
// (tools/restructure/browser-inner-proof.mjs), the checks that hold it afterwards, the
// name it leaves on `window` against every other name, and the survey of what can leave.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { nameClashes, recordedClashes } from '../../tools/restructure/browser-inner-names.mjs';
import { heldFunctions, planInnerScript, readWrapper } from '../../tools/restructure/browser-inner-plan.mjs';
import { innerStateProblems, proveInnerMove } from '../../tools/restructure/browser-inner-proof.mjs';
import { groupsOf, renderSurvey, surveyScript } from '../../tools/restructure/browser-inner-survey.mjs';
import { innerFilesOf, runOf, splitFiles } from '../../tools/restructure/browser-ledger.mjs';
import { compareRecordings } from '../../tools/restructure/browser-page-check.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const FILE = 'server/js/leaf.js';
const TARGET = 'server/js/leaf/keys.js';
const SOURCE = ["'use strict';", '// What the leaf does.', '(function () {', '  const LIMIT = 3;', '  let count = 0;', '', '  // The key of an element.', '  function keyOf(el) {', "    return el ? el.id : '';", '  }', '',
  '  function twice(n) {', '    return double(n) * 1;', '  }', '', '  function double(n) {', '    return n * 2;', '  }', '',
  '  function bump() {', '    count += 1;', '    return count > LIMIT ? keyOf(null) : String(twice(count));', '  }', '', '  window.Leaf = { bump, keyOf };', '})();', ''].join('\n');
const planOf = (text = SOURCE, names = ['keyOf', 'twice', 'double']) => planInnerScript({ text, parser, source: FILE, target: TARGET, about: 'The keys of the leaf.', names });
const proven = (before, plan, change = {}) => proveInnerMove({ before: change.before ?? before, after: change.after ?? plan.newSource, made: change.made ?? plan.targetText,
  plan: change.plan ?? plan, parser, source: FILE, target: TARGET }).join('\n');
// The fixtures below are texts the tool reads: none of them is ever run, the ones that say `eval` included.
const swap = (text, from, to) => { assert.ok(text.includes(from), `the text has ${from}`); return text.replace(from, () => to); };

test('a planned move is proven from the three texts, and a change to any of them is found', (t) => {
  if (!parser) return t.skip(SKIP);
  const plan = planOf();
  assert.equal(proven(SOURCE, plan), '');
  assert.match(proven(SOURCE, plan, { made: swap(plan.targetText, 'n * 2', 'n * 3') }), /does not hold the moved lines unchanged and in order[\s\S]*double is not the same text in server\/js\/leaf\/keys\.js/);
  assert.match(proven(SOURCE, plan, { after: swap(plan.newSource, 'count += 1;', 'count += 2;') }), /server\/js\/leaf\.js changed by more than the moved lines and the line that takes the functions back/);
  assert.match(proven(SOURCE, plan, { plan: { ...plan, glue: { ...plan.glue, at: plan.glue.at + 1 } } }), /the line that takes the functions back is not where the plan put it/);
  assert.match(proven(SOURCE, plan, { plan: { ...plan, ranges: plan.ranges.slice(1) } }), /changed by more than the moved lines/);
});

test('the new script may hold functions and the one line that names them on window, nothing that runs', (t) => {
  if (!parser) return t.skip(SKIP);
  const plan = planOf();
  const made = (from, to) => proven(SOURCE, plan, { made: swap(plan.targetText, from, to) });
  assert.match(made('  window.LeafKeys', "  document.title = 'x';\n  window.LeafKeys"), /keys\.js:18 is not a function declaration or a constant: a script made of moved code runs nothing while it loads/);
  assert.match(made('  window.LeafKeys', "  const box = document.querySelector('.box');\n  window.LeafKeys"), /keys\.js: box is not a value that is the same whenever it is worked out: it calls `document\.querySelector\(\)`/);
  assert.match(made('  window.LeafKeys', '  const cache = new Map();\n  window.LeafKeys'), /does not hold the moved lines unchanged and in order[\s\S]*cache was not a constant declared once, on lines of its own, in the wrapper of server\/js\/leaf\.js/);
  assert.match(made('{ keyOf, twice };', '{ keyOf: twice, twice };'), /must end with `window\.LeafKeys = \{ \.\.\. \};` naming its functions as they are, and nothing else/);
  assert.match(made('{ keyOf, twice };', '{ keyOf, twice, ...window.Other };'), /must end with `window\.LeafKeys/);
  assert.match(made('{ keyOf, twice };', '{ keyOf, twice, bump };'), /leaves bump on window\.LeafKeys, which is not one of its functions/);
  assert.match(made('window.LeafKeys = {', 'window.Leaf = {'), /must end with `window\.LeafKeys/);
  assert.match(made('})();\n', '})();\nwindow.after = 1;\n'), /is not one wrapper function around all its code/);
  assert.match(made("'use strict';\n", ''), /does not run in the same mode \(strict or not\) as server\/js\/leaf\.js/);
  assert.match(made('// The keys of the leaf.\n', ''), /must open with a comment saying what it does/);
  assert.match(proven(SOURCE, plan, { made: plan.targetText.replace(/\n {2}function double[\s\S]*?\n {2}\}\n/, '\n') }), /does not hold the moved lines unchanged/);
});

test('a function that took something from the wrapper, or was assigned again, is found on both sides', (t) => {
  if (!parser) return t.skip(SKIP);
  const plan = planOf();
  const both = (from, to) => proven(SOURCE, plan, { before: swap(SOURCE, from, to), after: plan.newSource.includes(from) ? swap(plan.newSource, from, to) : plan.newSource,
    made: plan.targetText.includes(from) ? swap(plan.targetText, from, to) : plan.targetText });
  assert.match(both("return el ? el.id : '';", 'return el ? el.id : String(LIMIT);'), /keyOf used LIMIT, which the wrapper of server\/js\/leaf\.js declared \(line 4\)[\s\S]*keyOf uses LIMIT, which the wrapper of server\/js\/leaf\.js declares/);
  assert.match(both('return n * 2;', 'return n * count;'), /double used count, which the wrapper of server\/js\/leaf\.js declared \(line 5\)/);
  assert.match(both('  window.Leaf = {', '  if (window.old) keyOf = null;\n  window.Leaf = {'), /server\/js\/leaf\.js assigned keyOf again[\s\S]*assigns keyOf again: the function in server\/js\/leaf\/keys\.js would not change with it/);
  assert.match(both('return n * 2;', 'return arguments.callee(n);'), /double says arguments\.callee/);
  assert.match(both('  window.Leaf = {', '  window.run = (code) => eval(code);\n  window.Leaf = {'), /says `eval`, which reads names nobody can list/);
  assert.match(both('  window.Leaf = {', '  window.old = window.LeafKeys;\n  window.Leaf = {'), /already had LeafKeys as a word[\s\S]*says LeafKeys more than once/);
});

test('the old script takes back exactly what the new one leaves, before anything of it can call one', (t) => {
  if (!parser) return t.skip(SKIP);
  const plan = planOf();
  const glue = '  const { keyOf, twice } = window.LeafKeys;';
  const lost = { after: swap(plan.newSource, glue, '  const { keyOf } = window.LeafKeys;'), plan: { ...plan, glue: { ...plan.glue, lines: ['  const { keyOf } = window.LeafKeys;', ''] } } };
  assert.match(proven(SOURCE, plan, lost), /takes keyOf from window\.LeafKeys, and server\/js\/leaf\/keys\.js leaves keyOf, twice there[\s\S]*still uses twice, which it does not take back/);
  const renamed = { after: swap(plan.newSource, glue, '  const { keyOf: key, twice } = window.LeafKeys;'), plan: { ...plan, glue: { ...plan.glue, lines: ['  const { keyOf: key, twice } = window.LeafKeys;', ''] } } };
  assert.match(proven(SOURCE, plan, renamed), /must take the functions of server\/js\/leaf\/keys\.js back on one line|takes nothing plainly from window\.LeafKeys/);
  // The line put below a value that is worked out with one of the functions while the script loads.
  const early = swap(SOURCE, '  const LIMIT = 3;', '  const first = twice(1);\n  const LIMIT = 3;');
  const right = planOf(early);
  assert.equal(proven(early, right), '');
  const late = right.newSource.split('\n');
  late.splice(right.glue.at, right.glue.lines.length);
  const below = late.indexOf('  let count = 0;') + 1;
  late.splice(below, 0, ...right.glue.lines);
  assert.match(proven(early, right, { after: late.join('\n'), plan: { ...right, glue: { ...right.glue, at: below } } }), /server\/js\/leaf\.js:4 could use keyOf, twice before the line that takes them back/);
});

test('the checks that hold a split wrapper afterwards find a hand edit on either side', (t) => {
  if (!parser) return t.skip(SKIP);
  const plan = planOf();
  const state = (text, made, more = []) => innerStateProblems({ source: FILE, text, parts: [{ file: TARGET, text: made }, ...more], parser }).join('\n');
  assert.equal(state(plan.newSource, plan.targetText), '');
  assert.match(state(plan.newSource, swap(plan.targetText, '  window.LeafKeys', '  keyOf(document.body);\n  window.LeafKeys')), /runs nothing while it loads/);
  assert.match(state(plan.newSource, swap(plan.targetText, 'return n * 2;', 'return n * LIMIT;')), /double uses LIMIT, which the wrapper of server\/js\/leaf\.js declares \(line 4\): out of the wrapper it means something else/);
  assert.match(state(swap(plan.newSource, '  const { keyOf, twice } = window.LeafKeys;\n', ''), plan.targetText), /must take the functions of server\/js\/leaf\/keys\.js back on one line, `const \{ \.\.\. \} = window\.LeafKeys;`: 0 such lines/);
  assert.match(state(swap(plan.newSource, 'String(twice(count))', 'String(double(count))'), plan.targetText), /still uses double, which it does not take back from server\/js\/leaf\/keys\.js/);
  assert.match(state(swap(plan.newSource, '  let count = 0;', '  let count = keyOf(null).length;'), plan.targetText), /leaf\.js:5 could use keyOf, twice before the line that takes them back/);
  assert.match(state(swap(plan.newSource, '(function () {', '(function (root) {'), plan.targetText), /functions were taken out of its wrapper: it must stay one/);
  const words = { file: 'server/js/leaf/words.js', text: "// The words.\n'use strict';\n\n(() => {\n  function shout(el) {\n    return double(el);\n  }\n\n  window.LeafWords = { shout };\n})();\n" };
  const withWords = swap(plan.newSource, '  const { keyOf, twice } = window.LeafKeys;\n', '  const { keyOf, twice } = window.LeafKeys;\n  const { shout } = window.LeafWords;\n').replace('{ bump, keyOf }', '{ bump, keyOf, shout }');
  assert.match(state(withWords, plan.targetText, [words]), /words\.js: shout uses double, a function of server\/js\/leaf\/keys\.js: out of the wrapper nothing has that name/);
  assert.equal(state(withWords, plan.targetText, [{ ...words, text: words.text.replace('double(el)', 'String(el)') }]), '');
});

test('the name left on window is nobody else\'s: not a word of another file, not the browser\'s, not on a page already', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-inner-names-'));
  try {
    const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
    write(FILE, '(function () {\n  const { keyOf } = window.LeafKeys;\n})();\n');
    write(TARGET, '(function () {\n  window.LeafKeys = { keyOf };\n})();\n');
    write('server/js/other.js', '// nothing\nif (window.LeafKeys) start();\nconst LeafKeysMore = 1;\n');
    write('server/test/leaf.test.mjs', 'assert.ok(window.LeafKeys);\n');
    const mine = { name: 'LeafKeys', from: FILE, file: TARGET };
    assert.deepEqual(nameClashes(root, [mine]), ['server/js/other.js:2 has LeafKeys as a word, the name server/js/leaf/keys.js leaves on window: a page would have two things under one name'],
      'a file that is not tracked yet is read too, a test is not, and a longer word is another word');
    assert.deepEqual(nameClashes(root, [{ ...mine, name: 'LeafWords' }]), []);
    assert.match(nameClashes(root, [mine, { name: 'LeafKeys', from: 'server/js/leaf-keys.js', file: 'server/js/leaf-keys/all.js' }]).join('\n'), /server\/js\/leaf-keys\/all\.js would leave LeafKeys on window, the name another script made of moved functions leaves there/);
    assert.deepEqual(nameClashes(root, []), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  const recording = { engine: { name: 'chromium', blank: ['History', 'PerformanceTiming'] }, views: [{ name: 'menu', globals: ['MenuRows'], declared: { LeafKeys: 'object' } }] };
  assert.deepEqual(recordedClashes(recording, 'PerformanceTiming'), ['PerformanceTiming is a name the browser itself has on window (chromium)']);
  assert.deepEqual(recordedClashes(recording, 'MenuRows'), ['MenuRows is on window already on menu']);
  assert.deepEqual(recordedClashes(recording, 'LeafKeys'), ['LeafKeys is on window already on menu']);
  assert.deepEqual(recordedClashes(recording, 'LeafWords'), []);
});

test('the page check lets the one new name through on the pages that now load the script, and only that', () => {
  const view = (more) => ({ name: 'wide', address: '/', pageErrors: [], consoleErrors: [], failedRequests: [], refused: [], globals: ['Leaf'], declared: {}, scripts: ['/js/leaf.js'], stylesheets: [], rules: 'x', ruleCount: 0, ...more });
  const recording = (more, engine = {}) => ({ engine: { name: 'chromium', blank: [], ...engine }, views: [view(more)], settings: {} });
  const ledger = { moves: [{ kind: 'inner', from: FILE, file: TARGET, about: 'x', names: ['keyOf'], gives: ['keyOf'], name: 'LeafKeys' }] };
  const split = { scripts: ['/js/leaf/keys.js', '/js/leaf.js'], globals: ['Leaf', 'LeafKeys'] };
  assert.deepEqual(compareRecordings(recording({}), recording(split), ledger), []);
  assert.match(compareRecordings(recording({}), recording(split), { moves: [] }).join('\n'), /new on window: LeafKeys[\s\S]*the scripts it loads changed: new \/js\/leaf\/keys\.js/);
  assert.match(compareRecordings(recording({}), recording({ ...split, globals: ['Leaf', 'LeafKeys', 'Stray'] }), ledger).join('\n'), /^wide: new on window: Stray$/);
  assert.match(compareRecordings(recording({}), recording({ ...split, globals: ['Leaf'] }), ledger).join('\n'), /loads server\/js\/leaf\/keys\.js, and LeafKeys is not on window/);
  assert.match(compareRecordings(recording({ globals: ['Leaf', 'LeafKeys'] }), recording(split), ledger).join('\n'), /LeafKeys, the name server\/js\/leaf\/keys\.js leaves on window, was taken before/);
  assert.match(compareRecordings(recording({}, { blank: ['LeafKeys'] }), recording(split), ledger).join('\n'), /was taken before/);
  assert.match(compareRecordings(recording({}), recording({ ...split, scripts: ['/js/leaf/keys.js', '/js/state.js', '/js/leaf.js'] }), ledger).join('\n'), /\/js\/leaf\.js and its parts do not load in a row/);
});

test('the list of moves gives a wrapped script its new scripts in load order', () => {
  const ledger = { moves: [{ kind: 'inner', from: FILE, file: TARGET, name: 'LeafKeys' }, { kind: 'script', from: 'server/js/tree.js', file: 'server/js/tree/values.js' },
    { kind: 'inner', from: FILE, file: 'server/js/leaf/words.js', name: 'LeafWords' }] };
  assert.deepEqual(runOf(ledger, FILE), [TARGET, 'server/js/leaf/words.js', FILE]);
  assert.deepEqual(innerFilesOf(ledger, FILE), [TARGET, 'server/js/leaf/words.js']);
  assert.deepEqual(innerFilesOf(ledger, 'server/js/tree.js'), []);
  assert.deepEqual(splitFiles(ledger), [FILE, 'server/js/tree.js']);
});

test('the survey counts what may leave, what keeps the rest, and what would free it', (t) => {
  if (!parser) return t.skip(SKIP);
  const found = surveyScript(SOURCE, FILE, parser);
  assert.deepEqual([found.all, found.free], [{ functions: 4, lines: 18 }, { functions: 3, lines: 13 }]);
  const none = { functions: 0, lines: 0 };
  assert.deepEqual(found.held, { reassigned: none, state: { functions: 1, lines: 5 }, const: none, early: none, other: none, needs: none });
  assert.deepEqual(found.along, { functions: 1, lines: 1 }, 'LIMIT is a number written out: it may go with whoever uses it');
  assert.deepEqual([found.ifState.functions, found.ifConst.functions, found.ifBoth.functions, found.ifEarly.functions], [4, 3, 4, 3], 'bump needs only the let now');
  assert.deepEqual(found.groups, [{ lines: 1, functions: 0, names: ['LIMIT'] }, { lines: 5, functions: 1, names: ['keyOf'] }, { lines: 8, functions: 2, names: ['twice', 'double'] }]);
  assert.deepEqual(found.rows.find((row) => row.name === 'bump'), { name: 'bump', what: 'function', lines: [20, 24], kind: 'state',
    stays: ['bump (line 20) uses count, a let of the wrapper that changes while the page runs (line 5), which stays'] });
  const more = SOURCE.replace('  window.Leaf = {', "  const label = (n) => `#${n}`;\n  const box = document.querySelector('.box');\n  function tag(n) { return label(n); }\n  function show() { box.textContent = tag(1); }\n"
    + '  function later() { return show(); }\n  function swap() { keyOf = null; }\n  window.Leaf = {');
  const wide = surveyScript(more, FILE, parser);
  assert.deepEqual(Object.fromEntries(wide.rows.map((row) => [row.name, row.kind])), { LIMIT: null, keyOf: 'reassigned', twice: null, double: null, bump: 'state', label: null, tag: null, show: 'const', later: 'needs', swap: 'needs' },
    'tag goes with the arrow it uses; box is read from the page, so show stays');
  assert.deepEqual(wide.rows.filter((row) => row.what === 'const').map((row) => row.name), ['LIMIT', 'label']);
  assert.equal(wide.ifConst.functions - wide.free.functions, 2, 'show and later with any constant');
  const shell = readWrapper(more, FILE, parser);
  assert.deepEqual(groupsOf([...heldFunctions(shell)].filter(([, why]) => why.length === 0).map(([record]) => record)).map((group) => group.map((record) => record.names[0])), [['LIMIT'], ['twice', 'double'], ['label', 'tag']]);
  assert.equal(surveyScript('function a() {}\n', FILE, parser).wrapped, false);
  const whole = surveyScript(SOURCE.replace('  window.Leaf = {', '  window.run = (code) => eval(code);\n  window.Leaf = {'), FILE, parser);
  assert.deepEqual([whole.free.functions, whole.whole], [0, ['eval']], 'a script that says eval stays whole');
  const text = renderSurvey({ scripts: [found, wide, surveyScript('function a() {}\n', 'server/js/flat.js', parser)] }, true).join('\n');
  assert.match(text, /2 scripts are one plain wrapper: 12 functions/);
  assert.match(text, /Can leave today: 6 functions \(22 lines\), and 3 constants whose value is written out \(3 lines\)\./);
  assert.match(text, /Without the rule that keeps a constant a statement above it could reach: 6 functions/);
  assert.match(text, /Held by code that runs while the script loads: none\./);
});
