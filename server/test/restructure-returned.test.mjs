// Cutting the object a function returns into part functions where it stands
// (tools/restructure `spread --returned`): the lines of the keys do not change, the
// function returns its parts called in the old order, each part is handed exactly
// what its keys read, and what could change a key's place or a value is refused.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { replay } from '../../tools/restructure/extract.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { LEDGER, PROTECTED, readLedger, recordSpread } from '../../tools/restructure/ledger.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { cutReturned, planReturned, proveReturned } from '../../tools/restructure/returned.mjs';
import { dropReturnedPart, returnedLines, undoReturnedInPlace, undoReturnedText } from '../../tools/restructure/returned-undo.mjs';
import { sameReturnProblems } from '../../tools/restructure/spread-eval.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const OLD = 'server/demo.js';
const SOURCE = ["const os = require('os');", 'const LIMITS = require("./limits.js");', '', '// What a stored blob becomes.', 'function tidy(value, extra) {',
  "  const source = value && typeof value === 'object' ? value : {};", '  // Old blobs get the new size.', '  const old = Number(source.version) < LIMITS.version;',
  '  return {', "    look: source.look === 'light' ? 'light' : 'dark', // or light", '    size: old ? LIMITS.size : source.size,', '    // The second group.',
  '    // Two lines of it. This value is old.', '    host: os.hostname(),', '    ports: [80, 443].filter((port) => port !== source.closed),', '',
  '    // The third group.', '    nested: {', '      deep: LIMITS.deep(extra),', '    },', "    'quoted-key': old,", '  };', '}', '',
  'module.exports = { tidy };', ''].join('\n');
const PARTS = [{ name: 'tidyLook', first: 'look' }, { name: 'tidyNet', first: 'host' }, { name: 'tidyRest', first: 'nested' }];
const CUT = { name: 'tidy', parts: PARTS };

const plan = (text = SOURCE, parts = PARTS, more = {}) => planReturned({ text, parser, source: OLD, name: 'tidy', parts, ...more });
const refusal = (text, parts, more) => {
  try { plan(text, parts, more); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; }
  return '';
};
const proven = (before, after_, parts = PARTS) => proveReturned({ before, after: after_, parser, source: OLD, spread: { name: 'tidy', parts } });
const swap = (text, from, to) => { assert.equal(text.split(from).length, 2, `the text has "${from}" once`); return text.replace(from, () => to); };

test('every part takes its keys with the comments above them, and is handed what they read under the same names', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan();
  const lines = SOURCE.split('\n');
  assert.equal(made.newSource, [...lines.slice(0, 3),
    'function tidyLook(source, old) {', '  return {', lines[9], lines[10], '  };', '}', '',
    'function tidyNet(source) {', '  return {', ...lines.slice(11, 16), '  };', '}', '',
    'function tidyRest(extra, old) {', '  return {', ...lines.slice(16, 21), '  };', '}', '',
    ...lines.slice(3, 9), '    ...tidyLook(source, old),', '    ...tidyNet(source),', '    ...tidyRest(extra, old),', ...lines.slice(21)].join('\n'));
  assert.deepEqual(made.parts.map((part) => part.keys), [2, 2, 2]);
  assert.deepEqual(made.parts.map((part) => part.params), [['source', 'old'], ['source'], ['extra', 'old']], 'a name in a comment or a text is not read: the second part is not handed `old`');
  assert.deepEqual(proven(SOURCE, made.newSource), []);
  assert.equal(undoReturnedInPlace(made.newSource, made), SOURCE, 'put back together it is the old file');
});

test('the cut file returns the same as the old one when it really runs', (t) => {
  if (!parser) return t.skip(SKIP);
  const run = (text) => {
    const module = { exports: {} };
    const required = { os: { hostname: () => 'pc' }, './limits.js': { version: 2, size: 3, deep: (n) => ({ n }) } };
    vm.runInNewContext(text, { module, require: (spec) => required[spec] });
    return module.exports.tidy;
  };
  const [old, now] = [run(SOURCE), run(plan().newSource)];
  for (const given of [[], [null], ['text'], [{}], [{ version: 1, look: 'light', size: 9, closed: 80 }, 'more'], [{ version: 5, size: 9 }, { any: 1 }]]) {
    assert.deepEqual(Object.keys(now(...given)), ['look', 'size', 'host', 'ports', 'nested', 'quoted-key']);
    assert.equal(JSON.stringify(now(...given)), JSON.stringify(old(...given)));
  }
});

test('a function that is not plain constants and then one object written out is refused', (t) => {
  if (!parser) return t.skip(SKIP);
  const NOT_PLAIN = /tidy is not `function tidy\(…\) \{` at the top level/;
  assert.match(refusal(swap(SOURCE, 'function tidy(value, extra) {', 'async function tidy(value, extra) {')), NOT_PLAIN);
  assert.match(refusal(swap(SOURCE, 'function tidy(value, extra) {', 'function* tidy(value, extra) {')), NOT_PLAIN);
  assert.match(refusal(swap(SOURCE, 'function tidy(value, extra) {', 'function tidy(value, extra = 1) {')), NOT_PLAIN);
  assert.match(refusal(swap(SOURCE, 'function tidy(value, extra) {', 'function tidy(value, { extra }) {')), NOT_PLAIN);
  assert.match(refusal(swap(SOURCE, 'function tidy(value, extra) {', 'const tidy = (value, extra) => {')), NOT_PLAIN);
  assert.match(refusal(swap(SOURCE, '  return {', '  return Object.freeze({').replace('  };\n}', '  });\n}')), NOT_PLAIN);
  assert.match(refusal(swap(SOURCE, "    'quoted-key': old,\n  };", "    'quoted-key': old };")), NOT_PLAIN);
  assert.match(refusal(swap(SOURCE, '  return {\n', '  if (extra) return {};\n  return {\n')), /does something before its return that is not `const name = \.\.\.`/);
  assert.match(refusal(swap(SOURCE, '  const old = ', '  let old = ')), /does something before its return/);
  assert.match(refusal(swap(SOURCE, "  const source = value && typeof value === 'object' ? value : {};", '  const { source } = { source: value || {} };')), /does something before its return/);
  assert.match(refusal(swap(SOURCE, 'function tidy(value, extra) {', 'function tidy(value, ...extra) {')), NOT_PLAIN);
  assert.match(refusal(SOURCE, PARTS, { protectedNames: new Set(['tidy']) }), /tidy is protected/);
  assert.match(planReturned({ text: SOURCE, parser, source: OLD, name: 'tidy', parts: PARTS }).newSource, /function tidyLook/);
  assert.throws(() => planReturned({ text: SOURCE, parser, source: OLD, name: 'nowhere', parts: PARTS }), Refusal);
});

test('an object that could come out in another order, or means something else outside its function, is refused', (t) => {
  if (!parser) return t.skip(SKIP);
  const withLine = (line) => swap(SOURCE, "    'quoted-key': old,", line);
  assert.match(refusal(withLine('    ...LIMITS,')), /an entry that is not `key: value`/);
  assert.match(refusal(withLine('    get late() { return 1; },')), /an entry that is not `key: value`/);
  assert.match(refusal(withLine('    [os.EOL]: 1,')), /a computed or numeric key/);
  assert.match(refusal(withLine("    '7': 1,")), /the key 7, which is not kept in written order/);
  assert.match(refusal(withLine('    __proto__: null,')), /the key __proto__/);
  assert.match(refusal(withLine("    look: 'light',")), /the key look twice/);
  assert.match(refusal(withLine('    self: this,')), /says `this`, which would mean something else in a part/);
  assert.match(refusal(withLine('    late: () => this.x,')), /says `this`/);
  assert.match(refusal(withLine('    count: arguments.length,')), /says `arguments`/);
  assert.match(refusal(withLine('    made: new.target,')), /says `new\.target`/);
  assert.match(refusal(withLine('    more: (extra = 2),')), /gives extra another value: a part would change its own copy/);
  assert.match(refusal(withLine('    more: extra++,')), /gives extra another value/);
  assert.equal(refusal(withLine('    more: [extra].map((old) => { old = 1; return old; }),')), '', 'a name of its own inside a value is not the function\'s');
  assert.equal(refusal(withLine('    more: source.list.push(1),')), '', 'changing what a name holds is the same in a part: it is handed the same object');
});

test('a part has to start at a key that begins its line, in order, and under a new name', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(refusal(SOURCE, [PARTS[0], { name: 'tidyNet', first: 'nowhere' }]), /nowhere is not a key of the object/);
  assert.match(refusal(SOURCE, [PARTS[0], { name: 'tidyNet', first: 'deep' }]), /deep is not a key of the object/, 'a key of a nested object is not a place to cut');
  assert.match(refusal(SOURCE, [PARTS[1], PARTS[2]]), /the first part has to start with the object: look is its first key/);
  assert.match(refusal(SOURCE, [PARTS[0], PARTS[2], PARTS[1]]), /host does not come after the part before it/);
  assert.match(refusal(SOURCE, [PARTS[0]]), /a cut needs two parts or more/);
  assert.match(refusal(SOURCE, [PARTS[0], { name: 'LIMITS', first: 'host' }]), /already has the word LIMITS/);
  assert.match(refusal(SOURCE, [PARTS[0], { name: 'source', first: 'host' }]), /already has the word source/);
  assert.match(refusal(SOURCE, [PARTS[0], { name: 'tidyLook', first: 'host' }]), /tidyLook is not a name of its own/);
  const sameLine = swap(SOURCE, "'dark', // or light\n    size: old", "'dark', size: old");
  assert.match(refusal(sameLine, [PARTS[0], { name: 'tidyNet', first: 'size' }]), /the key size does not begin its line/);
});

test('the proof notices a key that moved, changed, or went missing', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan().newSource;
  assert.match(proven(SOURCE, swap(made, 'size: old ? LIMITS.size', 'size: !old ? LIMITS.size')).join('\n'), /is not the old file byte for byte/);
  assert.match(proven(SOURCE, swap(made, '    ...tidyNet(source),\n    ...tidyRest(extra, old),', '    ...tidyRest(extra, old),\n    ...tidyNet(source),')).join('\n'), /does not return its recorded parts and nothing else/);
  assert.match(proven(SOURCE, swap(made, '    ...tidyRest(extra, old),\n', '')).join('\n'), /does not return its recorded parts and nothing else/);
  assert.match(proven(SOURCE, swap(made, '    ...tidyRest(extra, old),\n', '    ...tidyRest(extra, old),\n    late: 1,\n')).join('\n'), /does not return its recorded parts and nothing else/);
  assert.match(proven(SOURCE, swap(made, 'module.exports = { tidy };', 'module.exports = { tidy, tidyNet };')).join('\n'), /not the old file byte for byte/);
  assert.match(proven(SOURCE, swap(made, 'function tidyNet(source) {\n  return {', 'function tidyNet(source) {\n  source = {};\n  return {')).join('\n'), /was not found as a function that only returns an object/);
});

test('the proof stands on the code, not on what the planner says it did', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan().newSource;
  // A part that is not handed a name its keys read would read a top-level name, or none, in its place.
  const unhanded = swap(swap(made, 'function tidyRest(extra, old) {', 'function tidyRest(extra) {'), '...tidyRest(extra, old),', '...tidyRest(extra),');
  assert.match(proven(SOURCE, unhanded).join('\n'), /tidyRest is not handed exactly what its keys read of tidy: extra, old/);
  // Handed in another order, or handed more than it reads, is not what the tool writes either.
  const turned = swap(swap(made, 'function tidyRest(extra, old) {', 'function tidyRest(old, extra) {'), '...tidyRest(extra, old),', '...tidyRest(old, extra),');
  assert.match(proven(SOURCE, turned).join('\n'), /tidyRest is not handed exactly what its keys read/);
  const more = swap(swap(made, 'function tidyNet(source) {', 'function tidyNet(source, value) {'), '...tidyNet(source),', '...tidyNet(source, value),');
  assert.match(proven(SOURCE, more).join('\n'), /tidyNet is not handed exactly what its keys read of tidy: source/);
  // A call that hands other names than the part takes.
  assert.match(proven(SOURCE, swap(made, '...tidyRest(extra, old),', '...tidyRest(old, extra),')).join('\n'), /does not return its recorded parts and nothing else/);
  // A part used somewhere else too, with an old file written to match: the texts agree, the meaning may not.
  const before = swap(SOURCE, 'module.exports = { tidy };', 'module.exports = { tidy, n: typeof tidyNet };');
  assert.match(proven(before, swap(made, 'module.exports = { tidy };', 'module.exports = { tidy, n: typeof tidyNet };')).join('\n'),
    /tidyNet is named somewhere else than where it is declared and where it is called/);
  // Parts that do not stand right before the function.
  const lines = made.split('\n');
  const [from, to] = [lines.indexOf('function tidyNet(source) {'), lines.indexOf('function tidyRest(extra, old) {')];
  const moved = [...lines.slice(0, from), ...lines.slice(to, lines.length - 2), '', ...lines.slice(from, to - 1), ...lines.slice(lines.length - 2)].join('\n');
  assert.match(proven(SOURCE, moved).join('\n'), /not the old file byte for byte|do not stand right before it/);
  // An old function the rules refuse is not proven either, whatever the texts say.
  const bound = swap(SOURCE, "'quoted-key': old,", "'quoted-key': this,");
  assert.match(proven(bound, swap(made, "'quoted-key': old,", "'quoted-key': this,")).join('\n'), /says `this`/);
});

test('two ways of writing a function are compared by what they return', () => {
  const same = (oldCode, newCode, outside = ['X']) => sameReturnProblems({ oldCode, newCode, name: 'f', outside });
  assert.deepEqual(same('function f(v) { const s = v || {}; return { a: X(s.a), b: [s.b], c: { d: 1 } }; }',
    'function p(s) { return { a: X(s.a) }; }\nfunction q(s) { return { b: [s.b], c: { d: 1 } }; }\nfunction f(v) { const s = v || {}; return { ...p(s), ...q(s) }; }'), []);
  assert.match(same('function f() { return { a: 1, b: 2 }; }', 'function f() { return { b: 2, a: 1 }; }').join('\n'), /given nothing, f returns other keys, or the same in another order/);
  assert.match(same('function f(v) { return { a: X.a }; }', 'function f(v) { return { a: X.b }; }').join('\n'), /what f returns\.a is another value/);
  assert.match(same('function f(v) { return { a: v && v.a }; }', 'function f(v) { return { a: v && v.b }; }').join('\n'), /given an object with every key, what f returns\.a is another value/);
  assert.deepEqual(same('function f(v) { return { a: v.a }; }', 'function f(v) { return { a: v.a }; }'), [], 'failing the same way when given nothing is the same');
  assert.match(same('function f(v) { return { a: v.a }; }', 'function f(v) { return { a: v && v.a }; }').join('\n'), /given nothing, f no longer fails/);
  assert.match(same('function f(v) { return { a: 1 }; }', 'function f(v) { return { a: v.a.b.c }; }').join('\n'), /given nothing, f fails: /);
  assert.match(same('function f(v) { return { a: Y.a }; }', 'function f(v) { return { a: Y.a }; }').join('\n'), /fails whatever it is given when run with stand-ins: nothing could be compared/);
  assert.match(same('function f(v) { return {', 'function f(v) { return {').join('\n'), /could not be read with stand-ins/);
});

test('the keys are handed back to the tests that read the function as text, wherever the parts live', () => {
  const whole = ['const A = 1;', 'function big(value) {', '  const source = value || {};', '  return {', '    ...bigOne(source),', '    ...bigTwo(),', '  };', '}', ''].join('\n');
  const partFile = (name, params, lines) => ['// A part.', '', `function ${name}(${params}) {`, '  return {', ...lines, '  };', '}', '', `module.exports = { ${name} };`, ''].join('\n');
  const files = { bigOne: partFile('bigOne', 'source', ['    a: source.a,', '    // about b', '    b: 2,']), bigTwo: partFile('bigTwo', '', ['    c: { d: 3 },']) };
  const cut = { name: 'big', parts: [{ name: 'bigOne' }, { name: 'bigTwo' }] };
  assert.equal(undoReturnedText(whole, cut, (part) => files[part]),
    ['const A = 1;', 'function big(value) {', '  const source = value || {};', '  return {', '    a: source.a,', '    // about b', '    b: 2,', '    c: { d: 3 },', '  };', '}', ''].join('\n'));
  assert.equal(dropReturnedPart(files.bigTwo, 'bigTwo'), ['// A part.', '', 'module.exports = { bigTwo };', ''].join('\n'));
  assert.deepEqual(returnedLines(files.bigOne, 'bigOne').params, ['source']);
  assert.equal(returnedLines(whole, 'nowhere'), null);
  assert.throws(() => undoReturnedText(whole.replace('    ...bigTwo(),\n', ''), cut, (part) => files[part]), /big does not return its recorded parts and nothing else/);
  assert.throws(() => undoReturnedText(whole.replace('...bigOne(source),', '...bigOne(value),'), cut, (part) => files[part]), /big does not return its recorded parts and nothing else/);
  assert.throws(() => undoReturnedText(whole, cut, () => ''), /the part bigOne of big was not found/);
  assert.throws(() => dropReturnedPart(whole, 'bigOne'), /the part bigOne was not found/);
});

function demoRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'xenon-returned-'));
  mkdirSync(path.join(root, 'server'), { recursive: true });
  mkdirSync(path.join(root, 'tools', 'restructure'), { recursive: true });
  writeFileSync(path.join(root, PROTECTED), '{ "files": {} }\n');
  writeFileSync(path.join(root, 'server', 'limits.js'), 'module.exports = { version: 2, size: 3, deep: (n) => ({ n }) };\n');
  writeFileSync(path.join(root, OLD), SOURCE);
  return root;
}

test('a cut is written, recorded as a cut of what a function returns, and redone by the replay', (t) => {
  if (!parser) return t.skip(SKIP);
  const root = demoRepo();
  try {
    const dry = cutReturned({ root, parser, source: OLD, ...CUT, dryRun: true });
    assert.equal(readFileSync(path.join(root, OLD), 'utf8'), SOURCE, 'a dry run writes nothing');
    assert.equal(dry.sourceLines, 18, 'three parts: two first lines, two last lines, an empty line and a call line each');
    cutReturned({ root, parser, source: OLD, ...CUT });
    assert.equal(readFileSync(path.join(root, OLD), 'utf8'), plan().newSource);
    assert.deepEqual(readLedger(root).spreads, { [OLD]: [{ name: 'tidy', parts: PARTS, after: 0, returns: true }] });
    const show = (_root, _rev, file) => (file === OLD ? SOURCE : null);
    assert.deepEqual(replay({ root, parser, base: 'BASE', show }), { problems: [], replayed: 1, files: [[OLD]] });
    // A hand edit after the cut is seen.
    writeFileSync(path.join(root, OLD), readFileSync(path.join(root, OLD), 'utf8').replace('LIMITS.size :', 'LIMITS.size + 1 :'));
    assert.match(replay({ root, parser, base: 'BASE', show }).problems.join('\n'), /differs from BASE by more than the recorded moves/);
    // Once the revision's own list has the cut, it is not redone.
    const cutText = plan().newSource;
    writeFileSync(path.join(root, OLD), cutText);
    const later = (_root, _rev, file) => (file === OLD ? cutText : file === LEDGER ? readFileSync(path.join(root, LEDGER), 'utf8') : null);
    assert.deepEqual(replay({ root, parser, base: 'BASE', show: later }), { problems: [], replayed: 0, files: [[OLD]] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a record that cannot be redone is said, and a refused cut writes and records nothing', (t) => {
  if (!parser) return t.skip(SKIP);
  const root = demoRepo();
  try {
    assert.throws(() => cutReturned({ root, parser, source: OLD, name: 'tidy', parts: [PARTS[0]] }), Refusal);
    assert.equal(readFileSync(path.join(root, OLD), 'utf8'), SOURCE);
    assert.equal(readLedger(root).spreads, undefined);
    recordSpread(root, OLD, { name: 'tidy', parts: [PARTS[0], { name: 'tidyNet', first: 'gone' }], after: 0, returns: true });
    const show = (_root, _rev, file) => (file === OLD ? SOURCE : null);
    assert.match(replay({ root, parser, base: 'BASE', show }).problems.join('\n'), /tidy: the recorded cut cannot be redone from BASE: .*gone is not a key of the object/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
