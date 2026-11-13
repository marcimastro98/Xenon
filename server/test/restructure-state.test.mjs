// Turning shared `let` variables into properties of one object in a module of its
// own (tools/restructure, `state`): every use is renamed and nothing else, undone
// the file is the old file byte for byte, and whatever a plain rename would not
// keep is refused with a reason.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { analyze } from '../../tools/restructure/analyze.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { followRegistrations, proveState } from '../../tools/restructure/state.mjs';
import { planState } from '../../tools/restructure/state-plan.mjs';
import { undoStateText } from '../../tools/restructure/state-undo.mjs';
import { oldDeclarations, oldNames } from './engine-source.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

function plan(text, vars, more = {}) {
  const pairs = Object.entries(vars).map(([name, prop]) => ({ name, prop }));
  return planState({ text, analysis: analyze(text, parser, 'server/demo.js'), sourceFile: parser.parse(text, 'server/demo.js'), parser,
    source: 'server/demo.js', target: 'server/part/state.js', about: 'What the part remembers.', object: 'box', vars: pairs, ...more });
}
const refusal = (text, vars, more) => {
  try { plan(text, vars, more); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; }
  return '';
};
const proven = (text, made) => proveState({ before: text, after: made.newSource, moduleText: made.moduleText, plan: made, parser, source: 'server/demo.js' });
const file = (...lines) => [...lines, ''].join('\n');

const SOURCE = file(
  'const defaults = { a: 1 };',
  '// What was last read from disk.',
  'let current = { ...defaults };',
  '// How often it was saved.',
  'let saves = 0;   // since the start',
  'let last;',
  '',
  'function read() { return current.a + saves; }',
  'function save(next) {',
  '  current = { ...current, ...next };',
  '  saves += 1;',
  '  last = typeof current;',
  '  [current.a, saves] = [saves, current.a];',
  '  return { current: 1, saves: `${saves}` };',
  '}',
  'function other(current) { const saves = 2; return current + saves; }',
  '// current and saves stay in a comment, and in "current" text.',
  'const label = "current";',
);

test('every use becomes a property, a value that needs nothing moves, the rest keeps its line', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE, { current: 'now', saves: 'count', last: 'kind' });
  assert.equal(made.newSource, file(
    'const defaults = { a: 1 };',
    "const { box } = require('./part/state.js');",
    '// What was last read from disk.',
    'box.now = { ...defaults };',
    '',
    'function read() { return box.now.a + box.count; }',
    'function save(next) {',
    '  box.now = { ...box.now, ...next };',
    '  box.count += 1;',
    '  box.kind = typeof box.now;',
    '  [box.now.a, box.count] = [box.count, box.now.a];',
    '  return { current: 1, saves: `${box.count}` };',
    '}',
    'function other(current) { const saves = 2; return current + saves; }',
    '// current and saves stay in a comment, and in "current" text.',
    'const label = "current";',
  ));
  assert.equal(made.moduleText, file(
    '// What the part remembers.',
    '',
    'const box = {',
    '  now: undefined, // given its first value where the engine loads',
    '  // How often it was saved.',
    '  count: 0,   // since the start',
    '  kind: undefined,',
    '};',
    '',
    'module.exports = { box };',
  ));
  assert.deepEqual(made.kept, ['current']);
  assert.deepEqual(made.counts, {
    current: { found: 6, inProtected: 0, moved: false }, saves: { found: 5, inProtected: 0, moved: true }, last: { found: 1, inProtected: 0, moved: true },
  });
  assert.deepEqual(proven(SOURCE, made), []);
});

test('the require stands where the first let stood, also when that let leaves', (t) => {
  if (!parser) return t.skip(SKIP);
  const text = file('const a = 1;', '', '// Cache.', 'let hits = 0;', '', 'function hit() { hits += a; return hits; }');
  const made = plan(text, { hits: 'hits' });
  assert.deepEqual(made.newSource.split('\n').slice(0, 5), ['const a = 1;', '', "const { box } = require('./part/state.js');", '',
    'function hit() { box.hits += a; return box.hits; }']);
  assert.deepEqual(proven(text, made), []);
});

test('uses in protected code are renamed too, and counted', (t) => {
  if (!parser) return t.skip(SKIP);
  const text = file('let mode = "a";', 'function gate() { return mode === "a"; }', 'function set(v) { mode = v; }');
  const made = plan(text, { mode: 'mode' }, { protectedNames: new Set(['gate']) });
  assert.deepEqual(made.counts.mode, { found: 2, inProtected: 1, moved: true });
  assert.match(made.newSource, /function gate\(\) \{ return box\.mode === "a"; \}/);
  assert.match(refusal(text, { mode: 'mode' }, { protectedNames: new Set(['mode']) }), /mode .* is part of the security prelude/);
  assert.match(refusal(text, { mode: 'mode' }, { protectedStretches: [[-1, 1]] }), /inside a protected stretch that is never edited/);
});

test('a use a plain rename would not keep is refused', (t) => {
  if (!parser) return t.skip(SKIP);
  const cases = [
    [file('let stop = null;', 'function a() { if (stop) stop(); }'), /stop .* is called: as box\.x\(\) the function would get box as `this`/],
    [file('let n = 0;', 'function a() { return { n }; }'), /n .* stands in a \{ n \} shorthand/],
    [file('let n = 0;', 'function a(o) { ({ n } = o); }'), /n .* stands in a \{ n \} shorthand/],
    [file('let f = null;', 'function a() { f = () => 1; return f; }'), /f .* is given a function without a name of its own/],
    [file('let f = () => 1;', 'function a() { return f; }'), /f .* holds a function without a name of its own/],
    [file('let n = 0;', 'function a(box) { return n + box; }'), /a local called box is in scope where n is used/],
    [file('let n = 0;', 'function a() { n += 1; try { n = 2; } catch (box) { return 0; } return n; }'), /has a local, parameter or catch variable called box/],
    [file('let n = 0;', 'function a(flag) { if (flag) { const n = 1; return n; } return n; }'), /has a local, parameter or catch variable called n/],
    // The fixture below is text the tool reads, never run: it shows the tool refuses a file that calls eval.
    [file('let n = 0;', 'function a() { return eval("n"); }'), /calls eval/],
    [file('let tag = null;', 'function a() { return tag`x`; }'), /tag .* is called/],
    [file('let n = 0;', 'function a() { delete n; }'), /n .* is the operand of delete/],
    [file('let k = null;', 'function a() { k = class {}; return k; }'), /k .* is given a function without a name of its own/],
    [file('let n = 0;', 'function a(o) { with (o) { return n; } }'), /has a with statement/],
  ];
  for (const [text, expected] of cases) assert.match(refusal(text, Object.fromEntries([[text.slice(4, text.indexOf(' ', 4)), 'x']])), expected, text);
});

test('a declaration or a name the rewrite cannot handle is refused', (t) => {
  if (!parser) return t.skip(SKIP);
  const uses = 'function a() { return n; }';
  assert.match(refusal(file('const n = [];', uses), { n: 'n' }), /n .* is a const, not a let/);
  assert.match(refusal(file('let n = 0, m = 1;', uses), { n: 'n' }), /n .* is declared together with other names/);
  assert.match(refusal(file('let n = 0; let m = 1;', uses), { n: 'n' }), /n .* shares a line with another statement/);
  assert.match(refusal(file('let n = 0;', uses), { missing: 'n' }), /missing is not a top-level declaration/);
  assert.match(refusal(file('let n = 0;', uses, '// see box.n'), { n: 'n' }), /cannot become box\.n: the file has that text already/);
  assert.match(refusal(file('let n = 0;', uses, 'n = 2;'), { n: 'n' }), /is assigned by a statement that starts a line/);
  assert.match(refusal(file('const box = 1;', 'let n = 0;', uses), { n: 'n' }), /already declares box/);
  assert.match(refusal(file('let n = 0;', 'function a() { return n + box; }'), { n: 'n' }), /already uses a name box it does not declare/);
  assert.match(refusal(file('let n = 0;', 'let m = 0;', 'function a() { return n + m; }'), { n: 'x', m: 'x' }), /named twice/);
  assert.match(refusal(file('let n = 0;', uses), { n: 'not-a-name' }), /not-a-name cannot be a property name/);
});

test('a later let of the group that load-time code in between can reach is refused, with nothing in between it is taken', (t) => {
  if (!parser) return t.skip(SKIP);
  const head = ['let first = 0;', 'function peek() { return second; }'];
  const tail = ['let second = 0;', 'function both() { return first + second; }'];
  assert.match(refusal(file(...head, 'peek();', ...tail), { first: 'a', second: 'b' }),
    /second .*: the statement at line 3 runs while the file loads and can reach it before its declaration/);
  assert.match(refusal(file(...head, 'const early = second;', ...tail), { first: 'a', second: 'b' }), /second .*: the statement at line 3 runs/);
  const made = plan(file(...head, ...tail), { first: 'a', second: 'b' });
  assert.deepEqual(proven(file(...head, ...tail), made), []);
  // The one that is reached may start the object: the require then stands on its own line, as its `let` did.
  const alone = plan(file(...head, 'peek();', ...tail), { second: 'b' });
  assert.equal(alone.newSource.split('\n')[3], "const { box } = require('./part/state.js');");
});

test('the proof names a rewrite that is not the plain rename it claims to be', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE, { current: 'now', saves: 'count', last: 'kind' });
  const broken = (change) => proveState({ before: SOURCE, plan: made, parser, source: 'server/demo.js',
    after: made.newSource, moduleText: made.moduleText, ...change }).join('\n');
  assert.match(broken({ after: made.newSource.replace('box.count += 1;', 'box.count += 2;') }), /does not give the old file back byte for byte/);
  assert.match(broken({ after: made.newSource.replace('return box.now.a + box.count;', 'return box.now.a + saves;') }), /saves is still used/);
  assert.match(broken({ after: made.newSource.replace('const label = "current";', 'const label = "current"; box.other = 1;') }),
    /box is used at offset \d+ as something other than one of the new properties/);
  assert.match(broken({ after: made.newSource.replace('function read() {', 'function read() { void box.now;') }), /current: 6 uses were found, the new text has 8 of box.now .7 expected./);
  assert.match(broken({ moduleText: made.moduleText.replace('count: 0,', 'count: 1,') }), /does not hold exactly the values that left the file/);
  assert.match(broken({ moduleText: made.moduleText.replace('module.exports', 'box.kind = 3;\nmodule.exports') }), /has code besides the object and its export/);
});

test('the list of load statements follows a line that was respelled, and only that', (t) => {
  if (!parser) return t.skip(SKIP);
  const text = file('let mode = "a";', 'bus.onAsk(() => mode);', 'bus.onSet((v) => {', '  mode = v;', '});');
  const made = plan(text, { mode: 'mode' });
  const list = { files: { 'server/demo.js': [
    { statement: 'bus.onAsk(() => mode);', reason: 'r' }, { statement: 'bus.onSet((v) => {', reason: 'r' }, { statement: 'gone(() => mode);', reason: 'r' },
  ], 'server/other.js': [{ statement: 'bus.onAsk(() => mode);', reason: 'r' }] } };
  assert.deepEqual(followRegistrations(list, 'server/demo.js', made.newSource, made), ['bus.onAsk(() => box.mode);']);
  assert.deepEqual(list.files['server/demo.js'].map((entry) => entry.statement), ['bus.onAsk(() => box.mode);', 'bus.onSet((v) => {', 'gone(() => mode);']);
  assert.equal(list.files['server/other.js'][0].statement, 'bus.onAsk(() => mode);', 'another file keeps its entries');
  assert.deepEqual(followRegistrations(list, 'server/demo.js', made.newSource, made), [], 'a second run changes nothing');
});

test('the old names come back as text, for the proof and for the tests that read the engine', (t) => {
  if (!parser) return t.skip(SKIP);
  const state = { object: 'box', props: { current: 'now', saves: 'count', last: 'kind' }, kept: ['current'], bare: ['last'] };
  assert.equal(undoStateText('box.now = { ...box.now };\n  x(...box.count, box.counter, mybox.count, box.kind);', state),
    'let current = { ...current };\n  x(...saves, box.counter, mybox.count, last);');
  assert.equal(undoStateText('  box.now = 1;\nbox.now === 2;\nbox.now => 3;', state), '  current = 1;\ncurrent === 2;\ncurrent => 3;',
    'only a line that starts by assigning the name gets its let back');
  const made = plan(SOURCE, state.props);
  assert.equal(oldDeclarations(made.moduleText, { state }), ['// How often it was saved.', 'let saves = 0;   // since the start', 'let last;'].join('\n'));
  const undone = oldNames(made.newSource, [{ state }]);
  assert.ok(undone.includes('let current = { ...defaults };') && undone.includes('  current = { ...current, ...next };'));
  assert.ok(!/box\.(now|count|kind)/.test(undone));
});
