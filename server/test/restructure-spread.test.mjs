// Cutting one big frozen object into parts where it stands (tools/restructure
// spread): the lines of the keys do not change, the object is made of its parts in
// the old order, and what could change a key's place or a value is refused.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { replay } from '../../tools/restructure/extract.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { appendLedger, LEDGER, PROTECTED, readLedger, recordSpread } from '../../tools/restructure/ledger.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { planSpread, proveSpread, spreadObject } from '../../tools/restructure/spread.mjs';
import { sameObjectProblems, standIns } from '../../tools/restructure/spread-eval.mjs';
import { dropPart, undoSpreadInPlace, undoSpreadText } from '../../tools/restructure/spread-undo.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const OLD = 'server/demo.js';
const SOURCE = ["const os = require('os');", 'const LIMITS = require("./limits.js");', '', '// What a new install starts with.',
  'const DEFAULTS = Object.freeze({', "  look: 'dark', // or light", '  size: LIMITS.size,', '  // The second group.', '  // Two lines of it.',
  '  host: os.hostname(),', '  ports: Object.freeze([80, 443]),', '', '  // The third group.', '  nested: {', '    deep: LIMITS.deep(1),', '  },',
  "  'quoted-key': true,", '});', '', 'module.exports = { DEFAULTS };', ''].join('\n');
const PARTS = [{ name: 'DEFAULTS_LOOK', first: 'look' }, { name: 'DEFAULTS_NET', first: 'host' }, { name: 'DEFAULTS_REST', first: 'nested' }];

const plan = (text = SOURCE, parts = PARTS, more = {}) => planSpread({ text, parser, source: OLD, name: 'DEFAULTS', parts, ...more });
const refusal = (text, parts, more) => {
  try { plan(text, parts, more); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; }
  return '';
};
const proven = (before, after_, parts = PARTS) => proveSpread({ before, after: after_, parser, source: OLD, spread: { name: 'DEFAULTS', parts } });

test('every part takes its keys with the comments above them, and the object is its parts in order', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan();
  const lines = SOURCE.split('\n');
  assert.equal(made.newSource, [...lines.slice(0, 4),
    'const DEFAULTS_LOOK = Object.freeze({', lines[5], lines[6], '});', '',
    'const DEFAULTS_NET = Object.freeze({', ...lines.slice(7, 12), '});', '',
    'const DEFAULTS_REST = Object.freeze({', ...lines.slice(12, 17), '});', '',
    'const DEFAULTS = Object.freeze({', '  ...DEFAULTS_LOOK,', '  ...DEFAULTS_NET,', '  ...DEFAULTS_REST,', '});', ...lines.slice(18)].join('\n'));
  assert.deepEqual(made.parts.map((part) => part.keys), [2, 2, 2]);
  assert.deepEqual(proven(SOURCE, made.newSource), []);
  assert.equal(undoSpreadInPlace(made.newSource, made), SOURCE, 'put back together it is the old file');
});

test('the cut file gives the same object as the old one when it really runs', (t) => {
  if (!parser) return t.skip(SKIP);
  const run = (text) => {
    const module = { exports: {} };
    const required = { os: { hostname: () => 'pc' }, './limits.js': { size: 3, deep: (n) => ({ n }) } };
    vm.runInNewContext(text, { module, require: (spec) => required[spec] });
    return module.exports.DEFAULTS;
  };
  const [old, now] = [run(SOURCE), run(plan().newSource)];
  assert.deepEqual(Object.keys(now), ['look', 'size', 'host', 'ports', 'nested', 'quoted-key']);
  assert.equal(JSON.stringify(now), JSON.stringify(old));
  assert.ok(Object.isFrozen(now) && Object.isFrozen(now.ports) && !Object.isFrozen(now.nested));
});

test('an object that could come out in another order, or is not written out plainly, is refused', (t) => {
  if (!parser) return t.skip(SKIP);
  const withLine = (line) => SOURCE.replace("  'quoted-key': true,", line);
  assert.match(refusal(withLine('  ...LIMITS,')), /an entry that is not `key: value`/);
  assert.match(refusal(withLine('  get late() { return 1; },')), /an entry that is not `key: value`/);
  assert.match(refusal(withLine('  [os.EOL]: 1,')), /a computed or numeric key/);
  assert.match(refusal(withLine('  7: 1,')), /a computed or numeric key/);
  assert.match(refusal(withLine("  '7': 1,")), /the key 7, which is not kept in written order/);
  assert.match(refusal(withLine('  __proto__: null,')), /the key __proto__/);
  assert.match(refusal(withLine("  look: 'light',")), /the key look twice/);
  assert.match(refusal(SOURCE.replace('const DEFAULTS = Object.freeze({', 'const DEFAULTS = ({')), /is not `const DEFAULTS = Object\.freeze\(\{` on a line of its own/);
  assert.match(refusal(SOURCE.replace('const DEFAULTS = Object.freeze({', 'let DEFAULTS = Object.freeze({')), /on a line of its own/);
  assert.match(refusal(SOURCE.replace("  'quoted-key': true,\n});", "  'quoted-key': true });")), /on a line of its own/);
});

test('a part has to start at a key that begins its line, in order, and under a new name', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(refusal(SOURCE, [PARTS[0], { name: 'DEFAULTS_NET', first: 'nowhere' }]), /nowhere is not a key of the object/);
  assert.match(refusal(SOURCE, [PARTS[0], { name: 'DEFAULTS_NET', first: 'deep' }]), /deep is not a key of the object/, 'a key of a nested object is not a place to cut');
  assert.match(refusal(SOURCE, [PARTS[1], PARTS[2]]), /the first part has to start with the object: look is its first key/);
  assert.match(refusal(SOURCE, [PARTS[0], PARTS[2], PARTS[1]]), /host does not come after the part before it/);
  assert.match(refusal(SOURCE, [PARTS[0]]), /a cut needs two parts or more/);
  assert.match(refusal(SOURCE, [PARTS[0], { name: 'LIMITS', first: 'host' }]), /already has the word LIMITS/);
  assert.match(refusal(SOURCE, [PARTS[0], { name: 'DEFAULTS_LOOK', first: 'host' }]), /DEFAULTS_LOOK is not a name of its own/);
  const sameLine = SOURCE.replace("  look: 'dark', // or light\n  size: LIMITS.size,", "  look: 'dark', size: LIMITS.size,");
  assert.match(refusal(sameLine, [PARTS[0], { name: 'DEFAULTS_NET', first: 'size' }]), /the key size does not begin its line/);
  assert.match(refusal(SOURCE, PARTS, { protectedNames: new Set(['DEFAULTS']) }), /DEFAULTS is protected/);
});

test('the proof notices a key that moved, changed, or went missing', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan().newSource;
  assert.match(proven(SOURCE, made.replace('size: LIMITS.size,', 'size: LIMITS.size + 1,')).join('\n'), /is not the old file byte for byte/);
  assert.match(proven(SOURCE, made.replace('  ...DEFAULTS_NET,\n  ...DEFAULTS_REST,', '  ...DEFAULTS_REST,\n  ...DEFAULTS_NET,')).join('\n'), /is not made of its recorded parts|not the old file/);
  assert.match(proven(SOURCE, made.replace('  ...DEFAULTS_REST,\n', '')).join('\n'), /is not made of its recorded parts|not the old file/);
  assert.match(proven(SOURCE, made.replace('module.exports = { DEFAULTS };', 'module.exports = { DEFAULTS, DEFAULTS_NET };')).join('\n'), /not the old file byte for byte/);
});

test('the proof stands on the code, not on what the planner says it did', (t) => {
  if (!parser) return t.skip(SKIP);
  // A file where a part is also used elsewhere, with an old file written to match: the texts agree, the meaning may not.
  const made = plan().newSource;
  const before = SOURCE.replace('module.exports = { DEFAULTS };', 'module.exports = { DEFAULTS, n: typeof DEFAULTS_NET };');
  const after_ = made.replace('module.exports = { DEFAULTS };', 'module.exports = { DEFAULTS, n: typeof DEFAULTS_NET };');
  assert.match(proven(before, after_).join('\n'), /DEFAULTS_NET is named somewhere else than where it is declared and where it is spread/);
  // Parts that do not stand right before the object: something could run in between.
  const apart = made.replace('const DEFAULTS = Object.freeze({\n  ...DEFAULTS_LOOK', 'os.hostname();\nconst DEFAULTS = Object.freeze({\n  ...DEFAULTS_LOOK');
  const apartOld = SOURCE.replace('const DEFAULTS = Object.freeze({', 'os.hostname();\nconst DEFAULTS = Object.freeze({');
  assert.match(proven(apartOld, apart).join('\n'), /not the old file|do not stand right before it/);
});

test('two ways of writing an object are compared by what they give', () => {
  const same = (oldCode, newCode, outside = ['X']) => sameObjectProblems({ oldCode, newCode, name: 'N', outside });
  assert.deepEqual(same('const N = Object.freeze({ a: X.a, b: [X(1)], c: { d: 1 } });',
    'const P = Object.freeze({ a: X.a });\nconst Q = Object.freeze({ b: [X(1)], c: { d: 1 } });\nconst N = Object.freeze({ ...P, ...Q });'), []);
  assert.match(same('const N = Object.freeze({ a: 1, b: 2 });', 'const N = Object.freeze({ b: 2, a: 1 });').join('\n'), /Object\.keys\(N\) is another list, or in another order/);
  assert.match(same('const N = Object.freeze({ a: X.a });', 'const N = Object.freeze({ a: X.b });').join('\n'), /N\.a is another value/);
  assert.match(same('const N = Object.freeze({ a: X(1) });', 'const N = Object.freeze({ a: X(2) });').join('\n'), /N\.a is another value/);
  assert.match(same('const N = Object.freeze({ a: Object.freeze({}) });', 'const N = Object.freeze({ a: {} });').join('\n'), /N\.a is no longer frozen/);
  assert.match(same('const N = Object.freeze({ a: 1 });', 'const N = { a: 1 };').join('\n'), /N is not frozen after the cut/);
  assert.match(same('const N = Object.freeze({ a: [1, 2] });', 'const N = Object.freeze({ a: { 0: 1, 1: 2 } });').join('\n'), /N\.a is another kind of object/);
  assert.match(same('const N = Object.freeze({ a: Y });', 'const N = Object.freeze({ a: Y });', ['X']).join('\n'), /could not be worked out with stand-ins/);
  // A stand-in answers the same question with the same stand-in, also once it is frozen, and can be spread.
  const standIn = standIns();
  const x = standIn('X');
  assert.equal(x.list(1, 'a'), x.list(1, 'a'));
  assert.notEqual(x.list(1), x.list(2));
  assert.equal(`${x.a.b}`, 'X.a.b');
  assert.deepEqual([...x, { ...Object.freeze(x) }], [{}]);
  assert.equal(x.again, x.again);
});

test('the keys are handed back to the tests that read the object as text, wherever the parts live', () => {
  const whole = ['const A = 1;', 'const BIG = Object.freeze({', '  ...BIG_ONE,', '  ...BIG_TWO,', '});', ''].join('\n');
  const partFile = (name, lines) => ['// A part.', '', `const ${name} = Object.freeze({`, ...lines, '});', '', `module.exports = { ${name} };`, ''].join('\n');
  const files = { BIG_ONE: partFile('BIG_ONE', ['  a: 1,', '  // about b', '  b: 2,']), BIG_TWO: partFile('BIG_TWO', ['  c: { d: 3 },']) };
  const spread = { name: 'BIG', parts: [{ name: 'BIG_ONE' }, { name: 'BIG_TWO' }] };
  assert.equal(undoSpreadText(whole, spread, (part) => files[part]),
    ['const A = 1;', 'const BIG = Object.freeze({', '  a: 1,', '  // about b', '  b: 2,', '  c: { d: 3 },', '});', ''].join('\n'));
  assert.equal(dropPart(files.BIG_TWO, 'BIG_TWO'), ['// A part.', '', 'module.exports = { BIG_TWO };', ''].join('\n'));
  assert.throws(() => undoSpreadText(whole.replace('  ...BIG_TWO,\n', ''), spread, (part) => files[part]), /BIG is not made of its recorded parts and nothing else/);
  assert.throws(() => undoSpreadText(whole, spread, () => ''), /the part BIG_ONE of BIG was not found/);
});

function demoRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'xenon-spread-'));
  mkdirSync(path.join(root, 'server'), { recursive: true });
  mkdirSync(path.join(root, 'tools', 'restructure'), { recursive: true });
  writeFileSync(path.join(root, PROTECTED), '{ "files": {} }\n');
  writeFileSync(path.join(root, 'server', 'limits.js'), 'module.exports = { size: 3, deep: (n) => ({ n }) };\n');
  writeFileSync(path.join(root, OLD), SOURCE);
  return root;
}

test('a cut is written, recorded with its place in the order, and redone by the replay', (t) => {
  if (!parser) return t.skip(SKIP);
  const root = demoRepo();
  try {
    const dry = spreadObject({ root, parser, source: OLD, name: 'DEFAULTS', parts: PARTS, dryRun: true });
    assert.equal(readFileSync(path.join(root, OLD), 'utf8'), SOURCE, 'a dry run writes nothing');
    assert.equal(dry.sourceLines, 12, "three parts: a first line, a last line, an empty line and a spread line each");
    spreadObject({ root, parser, source: OLD, name: 'DEFAULTS', parts: PARTS });
    assert.deepEqual(readLedger(root).spreads, { [OLD]: [{ name: 'DEFAULTS', parts: PARTS, after: 0 }] });
    const show = (_root, _rev, file) => (file === OLD ? SOURCE : null);
    assert.deepEqual(replay({ root, parser, base: 'BASE', show }), { problems: [], replayed: 1, files: [[OLD]] });
    // A hand edit after the cut is seen.
    writeFileSync(path.join(root, OLD), readFileSync(path.join(root, OLD), 'utf8').replace('LIMITS.size,', 'LIMITS.size + 1,'));
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

test('the list of cuts survives the next recorded move, and a record that cannot be redone is said', (t) => {
  if (!parser) return t.skip(SKIP);
  const root = demoRepo();
  try {
    recordSpread(root, OLD, { name: 'DEFAULTS', parts: [PARTS[0], { name: 'DEFAULTS_NET', first: 'gone' }], after: 0 });
    appendLedger(root, 'server/other.js', { file: 'server/part/x.js', about: 'A part.', names: ['x'] });
    const ledger = readLedger(root);
    assert.equal(ledger.spreads[OLD][0].name, 'DEFAULTS');
    assert.deepEqual(Object.keys(ledger.sources), ['server/other.js']);
    const show = (_root, _rev, file) => (file === OLD ? SOURCE : null);
    const result = replay({ root, parser, base: 'BASE', show });
    assert.match(result.problems.join('\n'), /DEFAULTS: the recorded cut cannot be redone from BASE: .*gone is not a key of the object/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
