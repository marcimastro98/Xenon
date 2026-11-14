// A script made of code taken out of a browser script's wrapper may take names from the
// scripts made of the same wrapper before it (tools/restructure/browser-inner-takes.mjs):
// the line it begins with, what a constant may do with such a name, and every reason that
// refuses it, in the plan, in the proof and in the check that holds from then on.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { withConstants } from '../../tools/restructure/browser-inner-judge.mjs';
import { planInnerScript, readWrapperWith } from '../../tools/restructure/browser-inner-plan.mjs';
import { innerStateProblems, proveInnerMove } from '../../tools/restructure/browser-inner-proof.mjs';
import { surveyScript } from '../../tools/restructure/browser-inner-survey.mjs';
import { applyMove } from '../../tools/restructure/browser-moves.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const FILE = 'server/js/leaf.js';
const KEYS = 'server/js/leaf/keys.js';
const SIZES = 'server/js/leaf/sizes.js';
const WORDS = 'server/js/leaf/words.js';
const PAGE = 'server/index.html';
const HTML = '<body>\n<script src="js/leaf.js"></script>\n</body>\n';
const TOP = ["'use strict';", '// What the leaf does.', '(function () {'];
const VALUES = ['  const LIMIT = 3;', "  const SIZES = ['s', 'm'];", '  let count = 0;', ''];
const KEY_OF = ['  function keyOf(el) {', "    return el ? el.id : '';", '  }', ''];
const USERS = ['  function shout(el) { return keyOf(el).toUpperCase() + LIMIT; }', '', '  function size(n) { return SIZES[n % SIZES.length]; }', ''];
const REST = ['  function bump() {', '    count += 1;', "    SIZES.push('x' + count);", '    return [shout({ id: `k${count}` }), size(count), count > LIMIT, keyOf(null)];', '  }', '',
  '  window.Leaf = { bump };', '})();', ''];
const script = (...parts) => parts.flat().join('\n');
const SOURCE = script(TOP, VALUES, KEY_OF, USERS, REST);
const treeOf = (files) => ({ get: (file) => files[file] ?? null });
const refusal = (run) => { try { run(); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; } return ''; };

// One move after the other, each working from what the ones before it wrote.
function moves(text, ...jobs) {
  const files = { [FILE]: text, [PAGE]: HTML };
  const records = [];
  for (const [file, names] of jobs) {
    const done = applyMove(treeOf(files), { kind: 'inner', from: FILE, file, about: `Part of the leaf: ${names[0]}.`, names }, { parser, pages: [PAGE], earlier: [...records] });
    for (const [name, written] of done.files) files[name] = written;
    records.push(done.record);
  }
  return { files, records, parts: records.map((record) => ({ file: record.file, text: files[record.file] })) };
}
const FIRST = [KEYS, ['keyOf', 'LIMIT', 'SIZES']];
// The wrapper after the first move, with one more constant and a function that hands it out; both are asked to move.
function whyProbe(...lines) {
  const first = moves(SOURCE, FIRST);
  const text = first.files[FILE].replace('  function bump() {', () => [...lines, '  function probe() { return PROBE; }', '', '  function bump() {'].join('\n')).replace('{ bump }', '{ bump, probe }');
  return refusal(() => applyMove(treeOf({ ...first.files, [FILE]: text }), { kind: 'inner', from: FILE, file: WORDS, about: 'The probe.', names: ['PROBE', 'probe'] }, { parser, pages: [PAGE], earlier: first.records }));
}

// What the page gets: the scripts run one after the other in one window.
function answers(...scripts) {
  const window = {};
  window.window = window;
  vm.createContext(window);
  for (const text of scripts) vm.runInContext(text, window);
  return JSON.parse(JSON.stringify([1, 2, 3, 4].map(() => window.Leaf.bump())));
}

test('a later script begins by taking what its code uses of an earlier one, and the page gets the same answers', (t) => {
  if (!parser) return t.skip(SKIP);
  const done = moves(SOURCE, FIRST, [WORDS, ['shout', 'size']]);
  assert.equal(done.files[WORDS], script('// Part of the leaf: shout.', "'use strict';", '', '(() => {', '  const { LIMIT, SIZES, keyOf } = window.LeafKeys;', '',
    USERS, '  window.LeafWords = { shout, size };', '})();', ''));
  assert.equal(done.files[FILE], script(TOP, '  const { LIMIT, SIZES, keyOf } = window.LeafKeys;', '  let count = 0;', '', '  const { shout, size } = window.LeafWords;', '', REST),
    'the old script keeps the line that takes the first names back, and gains the second');
  assert.deepEqual(done.records[1], { kind: 'inner', from: FILE, file: WORDS, about: 'Part of the leaf: shout.', names: ['shout', 'size'], gives: ['shout', 'size'], name: 'LeafWords',
    takes: { LeafKeys: ['LIMIT', 'SIZES', 'keyOf'] } });
  assert.equal('takes' in done.records[0], false, 'a script that takes nothing is recorded as it always was');
  assert.match(done.files[PAGE], /<script src="js\/leaf\/keys\.js"><\/script>\n<script src="js\/leaf\/words\.js"><\/script>\n<script src="js\/leaf\.js"><\/script>/);
  // One list on every side: the old script pushes to it, the function in the third script reads what was pushed.
  assert.deepEqual(answers(done.files[KEYS], done.files[WORDS], done.files[FILE]), answers(SOURCE));
  assert.deepEqual(answers(SOURCE)[2], ['K33', 'x2', false, ''], 'the third answer names a size pushed by the second');
  assert.equal(innerStateProblems({ source: FILE, text: done.files[FILE], parts: done.parts, parser }).join('\n'), '');
});

test('it takes from each earlier script on a line of its own, in the order they load, only the names it uses', (t) => {
  if (!parser) return t.skip(SKIP);
  const done = moves(SOURCE, [KEYS, ['keyOf']], [SIZES, ['LIMIT', 'SIZES']], [WORDS, ['shout', 'size']]);
  // In the old script the line of the second move stands above the line of the first: the order in a new script is the order of loading.
  assert.match(done.files[FILE], /const \{ LIMIT, SIZES \} = window\.LeafSizes;\n {2}let count = 0;\n\n {2}const \{ keyOf \} = window\.LeafKeys;/);
  assert.match(done.files[WORDS], /\(\(\) => \{\n {2}const \{ keyOf \} = window\.LeafKeys;\n {2}const \{ LIMIT, SIZES \} = window\.LeafSizes;\n\n {2}function shout/);
  assert.deepEqual(done.records[2].takes, { LeafKeys: ['keyOf'], LeafSizes: ['LIMIT', 'SIZES'] });
  const one = moves(SOURCE, [KEYS, ['keyOf']], [SIZES, ['LIMIT', 'SIZES']], [WORDS, ['size']]);
  assert.match(one.files[WORDS], /\(\(\) => \{\n {2}const \{ SIZES \} = window\.LeafSizes;\n\n {2}function size/, 'not LIMIT, not keyOf');
  assert.deepEqual(answers(done.files[KEYS], done.files[SIZES], done.files[WORDS], done.files[FILE]), answers(SOURCE));
  assert.equal(innerStateProblems({ source: FILE, text: done.files[FILE], parts: done.parts, parser }).join('\n'), '');
  // A name of the wrapper that is not taken back from an earlier script is no more free than it was.
  assert.match(refusal(() => moves(SOURCE, [KEYS, ['keyOf']], [WORDS, ['shout']])), /shout \(server\/js\/leaf\.js:10\) uses LIMIT \(line 4\), a constant of the wrapper that stays, and its value is written out/);
  const own = SOURCE.replace('  let count = 0;', "  let count = 0;\n  const { far } = window.Elsewhere;").replace('return keyOf(el)', 'return far + keyOf(el)');
  assert.match(refusal(() => moves(own, FIRST, [WORDS, ['shout']])), /shout \(server\/js\/leaf\.js:\d+\) uses far \(line \d+\), a const of the wrapper that stays: the new script would not have it/,
    'a line that takes from somebody else\'s name on window is not one of these');
});

test('a constant may take such a name as it is, or compute with it when it is a number or a string there', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.equal(whyProbe('  const PROBE = { limit: LIMIT, sizes: SIZES, key: keyOf, twice: LIMIT * 2, text: `${LIMIT}px` };'), '');
  assert.match(whyProbe('  const PROBE = SIZES + 1;'), /PROBE \(server\/js\/leaf\.js:\d+\) computes with SIZES, taken from window\.LeafKeys \(line 4\), which is not a number or a string written out there/);
  assert.match(whyProbe('  const PROBE = `${keyOf}`;'), /computes with keyOf, taken from window\.LeafKeys \(line 4\)/);
  assert.match(whyProbe('  const PROBE = [...SIZES];'), /PROBE \(server\/js\/leaf\.js:\d+\) copies what SIZES holds at that moment, taken from window\.LeafKeys \(line 4\): code that runs between the two scripts could change it first/);
  assert.match(whyProbe('  const PROBE = new Set(SIZES);'), /copies what SIZES holds at that moment/);
  // Above the line that takes the name back the old script fails today; a constant that left would not.
  const first = moves(SOURCE, FIRST);
  const above = first.files[FILE].replace('  const { LIMIT, SIZES, keyOf } = window.LeafKeys;', '  const PROBE = [LIMIT];\n  const { LIMIT, SIZES, keyOf } = window.LeafKeys;')
    .replace('  function bump() {', '  function probe() { return PROBE; }\n\n  function bump() {').replace('{ bump }', '{ bump, probe }');
  assert.match(refusal(() => applyMove(treeOf({ ...first.files, [FILE]: above }), { kind: 'inner', from: FILE, file: WORDS, about: 'The probe.', names: ['PROBE', 'probe'] }, { parser, pages: [PAGE], earlier: first.records })),
    /PROBE \(server\/js\/leaf\.js:4\) reads LIMIT above the line that takes it back, taken from window\.LeafKeys \(line 5\)/);
  // The constants a named function uses go along when they read nothing but such names.
  const text = first.files[FILE].replace('  function bump() {', '  const TABLE = [LIMIT, keyOf];\n  function table() { return TABLE; }\n\n  function bump() {');
  assert.deepEqual(withConstants(readWrapperWith(text, FILE, parser, first.parts), ['table']), ['table', 'TABLE']);
  assert.deepEqual(withConstants(readWrapperWith(text, FILE, parser, []), ['table']), ['table'], 'not without the earlier script: then LIMIT is a name that stays');
});

test('the survey counts a function that only needs such names as free', (t) => {
  if (!parser) return t.skip(SKIP);
  const first = moves(SOURCE, FIRST);
  const row = (earlier) => surveyScript(first.files[FILE], FILE, parser, earlier).rows.find((entry) => entry.name === 'shout');
  assert.deepEqual(row(first.parts).stays, []);
  assert.match(row([]).stays[0], /shout \(line 7\) uses keyOf, a const of the wrapper \(line 4\), which stays/);
});

test('the proof reads the taken names on its own, in the old script and in the new one', (t) => {
  if (!parser) return t.skip(SKIP);
  const first = moves(SOURCE, FIRST);
  const before = first.files[FILE];
  const plan = planInnerScript({ text: before, parser, source: FILE, target: WORDS, about: 'Words.', names: ['shout', 'size'], earlier: first.parts });
  const proven = (change = {}) => proveInnerMove({ before, after: plan.newSource, made: plan.targetText, plan, parser, source: FILE, target: WORDS, earlier: first.parts, ...change }).join('\n');
  assert.equal(proven(), '');
  assert.match(proven({ earlier: [] }), /shout used keyOf, which the wrapper of server\/js\/leaf\.js declared \(line 4\)/, 'without the earlier script the names are the wrapper\'s own');
  assert.match(proven({ made: plan.targetText.replace('  const { LIMIT, SIZES, keyOf } = window.LeafKeys;\n\n', '') }), /shout used keyOf, which the wrapper of server\/js\/leaf\.js declared/);
  assert.match(proven({ made: plan.targetText.replace('window.LeafKeys;', 'window.LeafOther;') }), /server\/js\/leaf\/words\.js takes names from window\.LeafOther: no script made of server\/js\/leaf\.js that loads before it leaves that name/);
  // A statement above the line that took the names back could reach it: the old script fails there, the new one would not.
  const early = (text) => text.replace('  const { LIMIT, SIZES, keyOf } = window.LeafKeys;', '  bump();\n  const { LIMIT, SIZES, keyOf } = window.LeafKeys;');
  const forced = planInnerScript({ text: early(before), parser, source: FILE, target: WORDS, about: 'Words.', names: ['shout', 'size'], earlier: first.parts });
  assert.match(proveInnerMove({ before: early(before), after: forced.newSource, made: forced.targetText, plan: forced, parser, source: FILE, target: WORDS, earlier: first.parts }).join('\n'),
    /server\/js\/leaf\.js:4 could use LIMIT, SIZES, keyOf before the line that takes them back/);
});

test('what holds from then on: the lines stand first, name scripts that load before, and mean what the wrapper means', (t) => {
  if (!parser) return t.skip(SKIP);
  const done = moves(SOURCE, FIRST, [WORDS, ['shout', 'size']]);
  const take = '  const { LIMIT, SIZES, keyOf } = window.LeafKeys;';
  const state = ({ text = done.files[FILE], words = done.files[WORDS], parts = null } = {}) => innerStateProblems({ source: FILE, text,
    parts: parts ?? [{ file: KEYS, text: done.files[KEYS] }, { file: WORDS, text: words }], parser }).join('\n');
  assert.equal(state(), '');
  assert.match(state({ words: done.files[WORDS].replace(`${take}\n\n${USERS[0]}\n`, `${USERS[0]}\n\n${take}\n`) }), /words\.js: LIMIT, SIZES, keyOf is not a value that is the same whenever it is worked out: `\{ LIMIT, SIZES, keyOf \}` takes its names out of a value/,
    'under a function it is a line like any other');
  assert.match(state({ words: done.files[WORDS].replace(take, '  const { SIZES, LIMIT, keyOf } = window.LeafKeys;') }), /words\.js takes SIZES, LIMIT, keyOf from server\/js\/leaf\/keys\.js, which hands over LIMIT, SIZES, keyOf, in that order/);
  assert.match(state({ words: done.files[WORDS].replace(take, '  const { LIMIT, SIZES, keyOf, hidden } = window.LeafKeys;').replace('+ LIMIT;', '+ LIMIT + hidden;') }), /words\.js takes LIMIT, SIZES, keyOf, hidden from server\/js\/leaf\/keys\.js, which hands over LIMIT, SIZES, keyOf/);
  assert.match(state({ words: done.files[WORDS].replace('+ LIMIT;', ';') }), /words\.js takes LIMIT from window\.LeafKeys and does not use it/);
  assert.match(state({ words: done.files[WORDS].replace(take, '  const { LIMIT, SIZES } = window.LeafKeys;\n  const { keyOf } = window.LeafKeys;') }), /words\.js does not take from the earlier scripts once each, in the order they load/);
  assert.match(state({ parts: [{ file: WORDS, text: done.files[WORDS] }, { file: KEYS, text: done.files[KEYS] }] }), /words\.js takes names from window\.LeafKeys: no script made of server\/js\/leaf\.js that loads before it leaves that name/,
    'a script that loads after it cannot be taken from');
  assert.match(state({ words: done.files[WORDS].replace(USERS[0], `  const WIDE = SIZES + 1;\n${USERS[0]}`).replace('+ LIMIT;', '+ LIMIT + WIDE;') }), /words\.js: WIDE computes with SIZES, taken from window\.LeafKeys \(line 5\), which is not a number or a string written out there/);
  assert.equal(state({ words: done.files[WORDS].replace(USERS[0], `  const WIDE = LIMIT + 1;\n${USERS[0]}`).replace('+ LIMIT;', '+ LIMIT + WIDE;') }), '', 'a number written out in the earlier script may be computed with');
  // The old script must still mean the same thing by the name.
  const other = done.files[FILE].replace(take, '  const { LIMIT, SIZES } = window.LeafKeys;\n  const keyOf = (el) => String(el);');
  assert.match(state({ text: other }), /words\.js: shout takes keyOf from window\.LeafKeys, and the wrapper of server\/js\/leaf\.js means something else by that name \(line 5\)/);
});
