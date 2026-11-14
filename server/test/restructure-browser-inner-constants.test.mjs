// Constants that leave a browser script's wrapper with the functions that use them
// (tools/restructure/browser-inner-fixed.mjs, browser-inner-judge.mjs): which values may go,
// where they live afterwards, and every reason that keeps one where it is.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { withConstants } from '../../tools/restructure/browser-inner-judge.mjs';
import { planInnerScript, readWrapper } from '../../tools/restructure/browser-inner-plan.mjs';
import { innerStateProblems, proveInnerMove } from '../../tools/restructure/browser-inner-proof.mjs';
import { surveyScript } from '../../tools/restructure/browser-inner-survey.mjs';
import { applyMove } from '../../tools/restructure/browser-moves.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const FILE = 'server/js/leaf.js';
const TARGET = 'server/js/leaf/sizes.js';
const PAGE = 'server/index.html';
const ABOUT = 'The sizes of the leaf.';
const HTML = '<body>\n<script src="js/leaf.js"></script>\n</body>\n';
const TOP = ["'use strict';", '// What the leaf does.', '(function () {'];
const SIZES = ['  // The sizes a leaf may have.', "  const SIZES = ['s', 'm'];", '  const LIMIT = 3;', '  const STEP = LIMIT * 2 + 1;'];
const COUNT = ['  let count = 0;', ''];
const LABEL = ['  // How a size is shown.', '  const label = (size) => `${size}:${STEP}`;', ''];
const SIZE_OF = ['  function sizeOf(n) {', '    SIZES.seen = (SIZES.seen || 0) + 1;', '    return label(SIZES[n % SIZES.length]);', '  }', ''];
const REST = ['  function bump() {', '    count += 1;', "    SIZES.push('x' + count);", "    return count > LIMIT ? '' : sizeOf(count);", '  }', '',
  '  window.Leaf = { bump, sizes: () => [SIZES.length, SIZES.seen] };', '})();', ''];
const script = (...parts) => parts.flat().join('\n');
const SOURCE = script(TOP, SIZES, COUNT, LABEL, SIZE_OF, REST);
const ALL = ['sizeOf', 'SIZES', 'LIMIT', 'STEP', 'label'];
const treeOf = (files) => ({ get: (file) => files[file] ?? null });
const refusal = (run) => { try { run(); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; } return ''; };
const move = (text, names = ALL) => applyMove(treeOf({ [FILE]: text, [PAGE]: HTML }), { kind: 'inner', from: FILE, file: TARGET, about: ABOUT, names }, { parser, pages: [PAGE], earlier: [] });
const why = (text, names) => refusal(() => move(text, names));
// A wrapper with one more constant under LIMIT, and a function that hands it out; the constant and the function are asked to move.
const withConst = (...lines) => script(TOP, SIZES, lines, COUNT, '  function probe() { return PROBE; }', '', REST.slice(0, -3), '  window.Leaf = { bump, probe };', '})();', '');
const whyConst = (...lines) => why(withConst(...lines), ['PROBE', 'probe']);

// What the page gets: the scripts run one after the other in one window.
function answers(...scripts) {
  const window = { document: {} };
  window.window = window;
  vm.createContext(window);
  for (const text of scripts) vm.runInContext(text, window);
  return JSON.parse(JSON.stringify([...[1, 2, 3, 4].map(() => window.Leaf.bump()), window.Leaf.sizes()]));
}

test('a constant goes with the functions that use it: private when only they use it, handed back when the old script uses it too', (t) => {
  if (!parser) return t.skip(SKIP);
  const done = move(SOURCE);
  assert.equal(done.files.get(TARGET), script(`// ${ABOUT}`, "'use strict';", '', '(() => {', SIZES, '', LABEL, SIZE_OF, '  window.LeafSizes = { SIZES, LIMIT, sizeOf };', '})();', ''),
    'in the order they had, the comment above each with it, lines that touched still touching');
  assert.equal(done.files.get(FILE), script(TOP, '  const { SIZES, LIMIT, sizeOf } = window.LeafSizes;', COUNT, REST), 'STEP and label are used by nothing that stays: they are not handed back');
  assert.deepEqual(done.record, { kind: 'inner', from: FILE, file: TARGET, about: ABOUT, names: ['SIZES', 'LIMIT', 'STEP', 'label', 'sizeOf'], gives: ['SIZES', 'LIMIT', 'sizeOf'], name: 'LeafSizes' });
  // One list on both sides: the old script pushes to it, the moved function writes a property on it, and each sees the other's change.
  assert.deepEqual(answers(SOURCE), ['m:7', 'x1:7', 'x2:7', '', [6, 3]]);
  assert.deepEqual(answers(done.files.get(TARGET), done.files.get(FILE)), answers(SOURCE), 'the page answers the same');
  const again = applyMove(treeOf({ [FILE]: SOURCE, [PAGE]: HTML }), done.record, { parser, pages: [PAGE], earlier: [] });
  assert.deepEqual([...again.files], [...done.files], 'redone from its record, the move writes the same bytes');
  assert.deepEqual(move(SOURCE, ['LIMIT']).record.gives, ['LIMIT'], 'a constant may go alone, when the script still uses it');
});

test('the values that may go: written out, and of names that go with them', (t) => {
  if (!parser) return t.skip(SKIP);
  const values = ["  const TEXT = 'a';", '  const N = -1.5e3;', '  const YES = true, NO = false;', '  const NOT = !YES;', '  const NOTHING = null, UNSET = undefined;', '  const RE = /^a+$/g;', '  const PLAIN = `no names in it`;',
    '  const fn = function (x) { return x + N + count; };', '  const arrow = async (x) => fn(x);', "  const LIST = [TEXT, N, , ...['p'], [RE]];",
    "  const TABLE = { a: 1, 'b-c': LIST, 3: fn, ['lit']: arrow, method() { return this.a; }, YES };", "  const SET = new Set(['a', TEXT]);", '  const MAP = new Map([[TEXT, fn]]);', '  const EMPTY = new Map();',
    '  const FROZEN = Object.freeze({ list: Object.freeze([1, 2]), SET });', '  const SUM = N * 2 + (1 << 3) - -N;', "  const JOINED = TEXT + '-' + `${N}px`;", "  const COPY = [...LIST, 'q'];",
    '  const MERGED = { ...TABLE, z: 26 };', '  const BY_NAME = { probe };', '  const PROBE = [NO, NOT, NOTHING, UNSET, PLAIN, EMPTY, FROZEN, SUM, JOINED, COPY, MERGED, MAP, BY_NAME];'];
  const text = withConst(...values).replace('return x + N + count;', 'return x + N;');
  const names = [...withConstants(readWrapper(text, FILE, parser), ['probe'])];
  assert.equal(names.length, 22, 'every one of the 21 lines goes along with the function that hands them out');
  const done = move(text, names);
  assert.deepEqual(done.record.gives, ['probe']);
  const run = (...scripts) => { const window = {}; window.window = window; vm.createContext(window); for (const one of scripts) vm.runInContext(one, window); return JSON.stringify(window.Leaf.probe().map((value) => (value instanceof Map ? [...value.keys()] : value))); };
  assert.equal(run(done.files.get(TARGET), done.files.get(FILE)), run(text));
  assert.match(why(withConst(...values), names), /fn \(server\/js\/leaf\.js:\d+\) uses count \(line \d+\), a let of the wrapper that changes while the page runs/, 'the body of a function under a const obeys the rule of moved functions');
});

test('a value that asks the page, calls something or names what stays is refused, with the reason', (t) => {
  if (!parser) return t.skip(SKIP);
  const no = 'PROBE \\(server/js/leaf\\.js:8\\) is not a value that is the same whenever it is worked out: ';
  const refused = (line, reason) => assert.match(whyConst(line), new RegExp(no + reason), line);
  refused("  const PROBE = document.querySelector('.box');", 'it calls `document\\.querySelector\\(\\)`: the answer could be another when asked earlier');
  refused('  const PROBE = [Date.now()];', 'it calls `Date\\.now\\(\\)`');
  refused('  const PROBE = location.host;', '`location\\.host` is not a value written out');
  refused('  const PROBE = { lang: navigator.language };', '`navigator\\.language` is not a value written out');
  refused('  const PROBE = new Date();', '`new Date\\(\\)` is not a value written out');
  refused('  const PROBE = window.old ? 1 : 2;', '`window\\.old \\? 1 : 2` is not a value written out');
  refused('  const PROBE = { get now() { return 1; } };', '`get now\\(\\) \\{ return 1; \\}` is a getter or a setter: it runs when the value is read');
  refused('  const PROBE = { [LIMIT]: 1 };', 'the key `\\[LIMIT\\]` is worked out, not written out');
  refused('  const PROBE = () => this;', 'an arrow in it says `this`, which is the wrapper\'s');
  refused('  const PROBE = Object.freeze(SIZES);', '`Object\\.freeze\\(SIZES\\)` freezes something not written in place');
  refused('  const PROBE = [1] + 1;', '`\\[1\\]` is computed with, and is not a number or a string');
  refused('  const PROBE = [...SIZES.slice(1)];', '`SIZES\\.slice\\(1\\)` is copied from something that is not a name or a list written out');
  refused('  const { length: PROBE } = SIZES;', '`\\{ length: PROBE \\}` takes its names out of a value');
  // Two names of one statement: the first has its value when the second asks for it, and not the other way round.
  assert.equal(whyConst('  const FIRST = 1, PROBE = FIRST * 2;'), '');
  assert.match(whyConst('  const PROBE = FIRST, FIRST = 1;'), /PROBE, FIRST \(server\/js\/leaf\.js:8\) reads FIRST before its own statement has given it a value/);
  assert.match(whyConst('  const PROBE = PROBE;'), /PROBE \(server\/js\/leaf\.js:8\) reads PROBE before its own statement has given it a value/);
  assert.match(whyConst('  const FIRST = [1], PROBE = FIRST * 2;'), /FIRST, PROBE \(server\/js\/leaf\.js:8\) computes with FIRST \(line 8\), which is not a number or a string written out/);
  assert.match(whyConst('  const PROBE = () => arguments.length;'), /PROBE \(server\/js\/leaf\.js:8\) says `arguments` in an arrow, which is the wrapper's/);
  for (const name of ['window', 'document', 'localStorage', 'SERVER']) {
    assert.match(whyConst(`  const PROBE = { page: ${name} };`), new RegExp(`PROBE \\(server/js/leaf\\.js:8\\) reads ${name} while the script loads, a name of the page: it could be another value when read earlier`));
  }
  assert.match(whyConst('  const PROBE = [count];'), /PROBE \(server\/js\/leaf\.js:8\) uses count \(line 9\), a let of the wrapper that changes while the page runs/);
  assert.match(whyConst("  const HOME = document.querySelector('.home');", '  const PROBE = [...HOME];'), /PROBE \(server\/js\/leaf\.js:9\) uses HOME \(line 8\), a const of the wrapper that stays: the new script would not have it/);
  assert.match(whyConst('  const PROBE = [LIMIT];'), /PROBE \(server\/js\/leaf\.js:8\) uses LIMIT \(line 6\), a constant of the wrapper that stays, and its value is written out: name it too, or leave both/);
  assert.match(why(withConst('  const PROBE = SIZES + 1;'), ['PROBE', 'probe', 'SIZES']), /PROBE \(server\/js\/leaf\.js:8\) computes with SIZES \(line 5\), which is not a number or a string written out/);
  assert.match(why(withConst('  const PROBE = `${bump}`;'), ['PROBE', 'probe']), /uses bump \(line \d+\), a function of the wrapper that stays/);
});

test('a constant that is assigned to stays; changing what it holds does not keep it', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(why(SOURCE.replace("    SIZES.push('x' + count);", '    LIMIT = count;')), /LIMIT \(server\/js\/leaf\.js:6\) is assigned to in the script: a constant cannot be, and the error would move with it/);
  assert.match(why(SOURCE.replace("    SIZES.push('x' + count);", '    LIMIT += 1;')), /LIMIT \(server\/js\/leaf\.js:6\) is assigned to/);
  assert.match(why(SOURCE.replace('    SIZES.seen = (SIZES.seen || 0) + 1;', '    SIZES = [];')), /SIZES \(server\/js\/leaf\.js:5\) is assigned to/, 'by a function that moves too');
  // `SIZES.push(...)` in the script that stays and `SIZES.seen = ...` in the function that moves are both in SOURCE: the first test moves it and runs it.
  assert.equal(why(SOURCE.replace("    SIZES.push('x' + count);", "    SIZES.length = 0; delete SIZES.seen; SIZES.sort();")), '');
});

test('a statement above a constant that could reach it while the script loads keeps it: there the old script fails today', (t) => {
  if (!parser) return t.skip(SKIP);
  const above = (line) => script(TOP, line, SIZES, COUNT, LABEL, SIZE_OF, REST);
  const early = /LIMIT, STEP|SIZES|LIMIT \(server\/js\/leaf\.js:7\): line 4 could use it while the script loads, above the line that declares it: today that is an error, after the move it would not be/;
  assert.match(why(above('  bump();')), early, 'through a function that stays');
  assert.match(why(above('  const first = sizeOf(0);')), /label \(server\/js\/leaf\.js:12\): line 4 could use it while the script loads/, 'through a function that moves');
  assert.match(why(above("  document.addEventListener('x', () => bump());")), early, 'a function handed on may be called at once');
  assert.match(why(above('  const TWICE = [LIMIT];')), /LIMIT \(server\/js\/leaf\.js:7\): line 4 could use it while the script loads/, 'a written-out constant that reads it above its line');
  assert.equal(why(above("  console.log('up');")), '', 'code that reaches none of them is no reason');
  assert.equal(why(above('  const start = () => bump();')), '', 'nor is a function nobody calls yet: a constant that only builds a value runs nothing');
  // Below the constants the same statement is fine, and the line that takes the names back still stands above it.
  const below = script(TOP, SIZES, '  const first = sizeOf(0);', COUNT, LABEL, SIZE_OF, REST);
  assert.match(why(below), /label \(server\/js\/leaf\.js:12\): line 8 could use it/, 'label is declared under the statement that calls it');
  const fine = script(TOP, SIZES, LABEL, '  const first = sizeOf(0);', COUNT, SIZE_OF, REST);
  assert.equal(move(fine).files.get(FILE), script(TOP, '  const { SIZES, LIMIT, sizeOf } = window.LeafSizes;', '', '  const first = sizeOf(0);', COUNT, REST));
  assert.equal(surveyScript(above('  bump();'), FILE, parser).rows.find((row) => row.name === 'SIZES').kind, 'early');
});

test('the order in the new script is the order in the old one, and a value copied from another is copied at the same moment', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(whyConst('  const PROBE = [LATER];', '  const LATER = 1;'), /PROBE \(server\/js\/leaf\.js:8\) reads LATER above the line that declares it \(line 9\)/);
  assert.match(why(withConst('  const PROBE = [LATER];', '  const LATER = 1;'), ['PROBE', 'probe', 'LATER']), /reads LATER above the line that declares it/);
  const copied = (between) => why(withConst('  const BASE = [1];', between, '  const PROBE = [...BASE];').replace('window.Leaf = { bump, probe }', 'window.Leaf = { bump, probe, BASE }'), ['PROBE', 'probe', 'BASE']);
  assert.match(copied('  BASE.push(2);'), /PROBE \(server\/js\/leaf\.js:10\) copies what BASE \(line 8\) holds at that moment, and line 9 could change it first: copied earlier, it could hold something else/);
  assert.match(copied('  const grown = BASE.concat(2);'), /and line 9 could change it first/, 'any statement between the two that reaches the first');
  assert.equal(copied('  const grown = new Set(BASE);'), '', 'a constant that only copies it changes nothing');
  assert.equal(copied('  const other = [2];'), '', 'a constant that only builds a value changes nothing');
  assert.equal(copied('  function grow() { BASE.push(2); }'), '', 'nor does a function nobody has called');
  const done = move(withConst('  const BASE = [1];', '  const PROBE = new Map([[BASE, [...BASE]]]);'), ['probe', 'PROBE', 'BASE']);
  assert.match(done.files.get(TARGET), /\n {2}const BASE = \[1\];\n {2}const PROBE = new Map\(\[\[BASE, \[\.\.\.BASE\]\]\]\);\n\n {2}function probe/);
});

test('the proof reads a moved constant on its own: its text, its value, what stood above it, who assigns it', (t) => {
  if (!parser) return t.skip(SKIP);
  const plan = planInnerScript({ text: SOURCE, parser, source: FILE, target: TARGET, about: ABOUT, names: ALL });
  const texts = { before: SOURCE, after: plan.newSource, made: plan.targetText };
  const proven = (change = {}) => proveInnerMove({ ...texts, ...change, plan, parser, source: FILE, target: TARGET }).join('\n');
  assert.equal(proven(), '');
  assert.match(proven({ made: texts.made.replace('const LIMIT = 3;', 'const LIMIT = 4;') }), /does not hold the moved lines unchanged and in order/);
  assert.match(proven({ made: texts.made.replace("  const SIZES = ['s', 'm'];\n  const LIMIT = 3;", "  const LIMIT = 3;\n  const SIZES = ['s', 'm'];") }), /does not hold the moved lines unchanged and in order/, 'nor in another order');
  // The old text is judged again: a constant that could not leave is found whoever planned the move.
  const early = SOURCE.replace('  let count = 0;', '  let count = 0;\n  bump();');
  const forced = { before: early, after: texts.after.replace('  let count = 0;', '  let count = 0;\n  bump();') };
  assert.match(proven(forced), /label \(server\/js\/leaf\.js:12\): line 9 could use it while the script loads, above the line that declares it/);
  const state = (text, made) => innerStateProblems({ source: FILE, text, parts: [{ file: TARGET, text: made }], parser }).join('\n');
  assert.equal(state(texts.after, texts.made), '');
  assert.match(state(texts.after, texts.made.replace('const LIMIT = 3;', 'const LIMIT = window.limit;')), /sizes\.js: LIMIT is not a value that is the same whenever it is worked out: `window\.limit` is not a value written out/);
  assert.match(state(texts.after, texts.made.replace('const LIMIT = 3;', 'const LIMIT = count;')), /sizes\.js: LIMIT reads count while the script loads, a name of the page: it could be another value when read earlier/);
  assert.match(state(texts.after, texts.made.replace("  const SIZES = ['s', 'm'];\n  const LIMIT = 3;", "  const LIMIT = 3;\n  const SIZES = ['s', 'm'];").replace('const STEP = LIMIT', 'const STEP = EXTRA').replace('  window.LeafSizes', '  const EXTRA = 1;\n  window.LeafSizes')),
    /sizes\.js: STEP reads EXTRA above the line that declares it/);
  assert.match(state(texts.after.replace('    count += 1;', '    count += 1; LIMIT = 4;'), texts.made), /server\/js\/leaf\.js assigns LIMIT again: the constant in server\/js\/leaf\/sizes\.js would not change with it/);
  assert.match(state(texts.after.replace('  let count = 0;', '  let count = STEP;'), texts.made), /server\/js\/leaf\.js still uses STEP, which it does not take back from server\/js\/leaf\/sizes\.js/, 'a constant kept private is not one the old script may name');
  assert.match(state(texts.after.replace("    SIZES.push('x' + count);", '    label(count);'), texts.made), /server\/js\/leaf\.js still uses label, which it does not take back/);
  assert.match(state(texts.after.replace('  const { SIZES, LIMIT, sizeOf } = window.LeafSizes;\n  let count = 0;', '  let count = LIMIT;\n  const { SIZES, LIMIT, sizeOf } = window.LeafSizes;'), texts.made),
    /leaf\.js:4 could use SIZES, LIMIT, sizeOf before the line that takes them back/);
});
